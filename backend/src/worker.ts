import { Queue, Worker } from "bullmq";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Job } from "bullmq";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";

const eventChannel = "certiflow:events";
const redisConnection = () => redis.duplicate({ maxRetriesPerRequest: null });

type IssuanceJob = {
  batchId: string;
  candidateId: string;
};

async function issueCertificate(job: Job<IssuanceJob>) {
  const { batchId, candidateId } = job.data;
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, batchId },
    select: { id: true },
  });

  if (!candidate) {
    throw new Error(`Candidate ${candidateId} does not belong to batch ${batchId}`);
  }

  const certificateNumber = `PSM-2026-${candidateId.slice(-6).toUpperCase()}`;
  await prisma.certificate.upsert({
    where: { candidateId },
    create: {
      certificateNumber,
      batchId,
      candidateId,
      status: "VALID",
      whatsappStatus: "PENDING",
      issuedAt: new Date(),
    },
    update: {},
  });

  if (Math.random() < 0.3) {
    throw new Error("WhatsApp Gateway Timeout");
  }

  const sentCertificate = await prisma.certificate.update({
    where: { candidateId },
    data: { whatsappStatus: "SENT" },
  });

  const batchIssued = await prisma.$transaction(async (transaction) => {
    const [candidateCount, sentCount] = await Promise.all([
      transaction.candidate.count({ where: { batchId } }),
      transaction.certificate.count({
        where: { batchId, whatsappStatus: "SENT" },
      }),
    ]);

    if (candidateCount === 0 || sentCount !== candidateCount) {
      return false;
    }

    const result = await transaction.batch.updateMany({
      where: { id: batchId, status: "STATE_APPROVED" },
      data: { status: "ISSUED" },
    });
    return result.count > 0;
  });

  await redis.publish(
    eventChannel,
    JSON.stringify({
      type: "CERTIFICATE_ISSUED",
      batchId,
      candidateId,
      certificate: sentCertificate,
      batchStatus: batchIssued ? "ISSUED" : undefined,
    }),
  );
}

async function checkStuckBatches() {
  const thresholdSeconds = Number(process.env.SLA_THRESHOLD_SECONDS || 120);
  const cutoff = new Date(Date.now() - thresholdSeconds * 1000);

  const breachedBatchIds = await prisma.$transaction(async (transaction) => {
    const staleBatches = await transaction.batch.findMany({
      where: {
        status: { in: ["SUBMITTED", "DISTRICT_APPROVED", "QUALITY_APPROVED"] },
        updatedAt: { lt: cutoff },
        isSlaBreached: false,
      },
      select: { id: true, centreId: true },
    });
    const breachedIds: string[] = [];

    for (const batch of staleBatches) {
      const update = await transaction.batch.updateMany({
        where: {
          id: batch.id,
          status: { in: ["SUBMITTED", "DISTRICT_APPROVED", "QUALITY_APPROVED"] },
          updatedAt: { lt: cutoff },
          isSlaBreached: false,
        },
        data: { isSlaBreached: true },
      });

      if (update.count === 0) continue;

      await transaction.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: batch.id,
          actorId: batch.centreId,
          action: "SLA_BREACHED",
          metadata: { source: "SLA_MONITOR", thresholdSeconds },
        },
      });
      breachedIds.push(batch.id);
    }

    return breachedIds;
  });

  for (const batchId of breachedBatchIds) {
    await redis.publish(
      eventChannel,
      JSON.stringify({ type: "SLA_BREACHED", batchId }),
    );
  }
}

export async function startWorkers(): Promise<() => Promise<void>> {
  const slaQueue = new Queue("sla-monitor", { connection: redisConnection() });

  await slaQueue.add(
    "check-stuck-batches",
    {},
    {
      jobId: "check-stuck-batches",
      repeat: { every: 30_000 },
    },
  );

  const issuanceWorker = new Worker<IssuanceJob>(
    "cert-issuance",
    issueCertificate,
    { connection: redisConnection(), concurrency: 5 },
  );
  const slaWorker = new Worker("sla-monitor", checkStuckBatches, {
    connection: redisConnection(),
    concurrency: 1,
  });

  issuanceWorker.on("error", (error) => {
    console.error("Certificate issuance worker error:", error);
  });
  issuanceWorker.on("failed", (job, error) => {
    console.error(`Certificate issuance job ${job?.id ?? "unknown"} failed:`, error);
  });
  slaWorker.on("error", (error) => {
    console.error("SLA monitor worker error:", error);
  });
  slaWorker.on("failed", (job, error) => {
    console.error(`SLA monitor job ${job?.id ?? "unknown"} failed:`, error);
  });

  return async () => {
    const repeatableJobs = await slaQueue.getRepeatableJobs();
    await Promise.all(
      repeatableJobs
        .filter((job) => job.name === "check-stuck-batches")
        .map((job) => slaQueue.removeRepeatableByKey(job.key)),
    );
    await Promise.all([issuanceWorker.close(), slaWorker.close(), slaQueue.close()]);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorkers()
    .then((stopWorkers) => {
      const shutdown = () => {
        void stopWorkers()
          .then(() => Promise.all([prisma.$disconnect(), redis.quit()]))
          .then(() => {
            process.exitCode = 0;
          })
          .catch((error: unknown) => {
            console.error("Failed to stop Certiflow workers:", error);
            process.exitCode = 1;
          });
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      console.log("Certiflow workers started");
    })
    .catch((error: unknown) => {
      console.error("Failed to start Certiflow workers:", error);
      process.exitCode = 1;
    });
}
