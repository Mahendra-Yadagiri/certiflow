import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import type { UserRole } from "@prisma/client";
import { app } from "../src/server.js";
import { prisma } from "../src/prisma.js";
import { startWorkers } from "../src/worker.js";
import { closeApprovalQueue } from "../src/routes/approvals.js";
import { redis } from "../src/redis.js";

const api = supertest(app);
const users = [
  { id: "anika", name: "Anika", role: "CENTRE", district: "North" },
  { id: "dev", name: "Dev", role: "DISTRICT_OFFICER", district: "North" },
  { id: "meera", name: "Meera", role: "DISTRICT_OFFICER", district: "North" },
  { id: "kabir", name: "Kabir", role: "DISTRICT_OFFICER", district: "North" },
  { id: "neha", name: "Neha", role: "QUALITY_TEAM", district: null },
  { id: "farah", name: "Farah", role: "STATE_OFFICE", district: null },
] satisfies Array<{
  id: string;
  name: string;
  role: UserRole;
  district: string | null;
}>;

const centre = { "x-user-id": "anika" };
const districtOfficer = (id: "dev" | "meera" | "kabir") => ({ "x-user-id": id });
const stateOffice = { "x-user-id": "farah" };
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../sample-data/${name}`, import.meta.url));
const createdBatchIds = new Set<string>();

let stopWorkers: (() => Promise<void>) | undefined;
let savedSlaThreshold: string | undefined;

async function uploadBatch(
  filename: string,
  name: string,
  headers = centre,
) {
  const response = await api
    .post("/api/batches/upload")
    .set(headers)
    .field("courseName", name)
    .attach("file", fixture(filename));
  if (response.status === 201) createdBatchIds.add(response.body.id as string);
  return response;
}

async function approveDistrictTwice(batchId: string) {
  const [dev, meera] = await Promise.all([
    api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("dev"))
      .send({ decision: "APPROVED" }),
    api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("meera"))
      .send({ decision: "APPROVED" }),
  ]);
  expect([dev.status, meera.status]).toEqual([200, 200]);
}

describe.sequential("Certiflow integration", () => {
  beforeAll(async () => {
    savedSlaThreshold = process.env.SLA_THRESHOLD_SECONDS;
    process.env.SLA_THRESHOLD_SECONDS = "3600";
    for (const user of users) {
      await prisma.user.upsert({
        where: { id: user.id },
        create: user,
        update: user,
      });
    }
    stopWorkers = await startWorkers();
  }, 30_000);

  afterAll(async () => {
    await stopWorkers?.();

    const batchIds = [...createdBatchIds];
    if (batchIds.length > 0) {
      const certificates = await prisma.certificate.findMany({
        where: { batchId: { in: batchIds } },
        select: { id: true },
      });
      await prisma.certificate.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.candidate.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.batchApproval.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: [...batchIds, ...certificates.map(({ id }) => id)] } },
      });
      await prisma.batch.deleteMany({ where: { id: { in: batchIds } } });
    }

    await closeApprovalQueue();
    await prisma.$disconnect();
    await redis.quit();
    if (savedSlaThreshold === undefined) {
      delete process.env.SLA_THRESHOLD_SECONDS;
    } else {
      process.env.SLA_THRESHOLD_SECONDS = savedSlaThreshold;
    }
  }, 30_000);

  it("rejects invalid CSV atomically with row-level errors", async () => {
    const [batchesBefore, candidatesBefore] = await Promise.all([
      prisma.batch.count(),
      prisma.candidate.count(),
    ]);

    const response = await uploadBatch("invalid-batch.csv", "Invalid upload");

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: expect.any(Number), field: expect.any(String), message: expect.any(String) }),
      ]),
    );
    expect(response.body.errors.length).toBeGreaterThan(0);
    expect(await prisma.batch.count()).toBe(batchesBefore);
    expect(await prisma.candidate.count()).toBe(candidatesBefore);
  });

  it("serializes concurrent district approvals and transitions once", async () => {
    const uploaded = await uploadBatch("valid-batch.csv", "Concurrent approvals");
    expect(uploaded.status).toBe(201);
    const batchId = uploaded.body.id as string;

    await approveDistrictTwice(batchId);

    const [approvals, batch] = await Promise.all([
      prisma.batchApproval.findMany({
        where: { batchId, stage: "DISTRICT", decision: "APPROVED", isActive: true },
      }),
      prisma.batch.findUniqueOrThrow({ where: { id: batchId } }),
    ]);
    expect(approvals).toHaveLength(2);
    expect(batch.status).toBe("DISTRICT_APPROVED");
  });

  it("rejects State Office actions from Anika and Kabir", async () => {
    const uploaded = await uploadBatch("valid-batch.csv", "RBAC enforcement");
    expect(uploaded.status).toBe(201);
    const batchId = uploaded.body.id as string;
    await approveDistrictTwice(batchId);

    const candidate = await prisma.candidate.findFirstOrThrow({ where: { batchId } });
    const certificate = await prisma.certificate.create({
      data: {
        certificateNumber: `RBAC-${candidate.id}`,
        batchId,
        candidateId: candidate.id,
        status: "VALID",
        whatsappStatus: "PENDING",
        issuedAt: new Date(),
      },
    });

    await prisma.batch.update({
      where: { id: batchId },
      data: { status: "QUALITY_APPROVED" },
    });

    for (const headers of [centre, districtOfficer("kabir")]) {
      const approval = await api
        .post(`/api/batches/${batchId}/decision`)
        .set(headers)
        .send({ decision: "APPROVED" });
      const revoke = await api
        .post(`/api/certificates/${certificate.id}/revoke`)
        .set(headers)
        .send({ reason: "Unauthorized attempt" });
      expect(approval.status).toBe(403);
      expect(revoke.status).toBe(403);
    }
  });

  it("requires Quality Team review for large batches before State approval", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const uploaded = await uploadBatch("large-batch.csv", "Large batch quality gate");
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.candidateCount).toBe(35);
      const batchId = uploaded.body.id as string;
      await approveDistrictTwice(batchId);

      const earlyStateApproval = await api
        .post(`/api/batches/${batchId}/decision`)
        .set(stateOffice)
        .send({ decision: "APPROVED" });
      expect(earlyStateApproval.status).toBe(403);
      expect(
        await prisma.batch.findUniqueOrThrow({ where: { id: batchId } }).then((batch) => batch.status),
      ).toBe("DISTRICT_APPROVED");

      const qualityApproval = await api
        .post(`/api/batches/${batchId}/decision`)
        .set({ "x-user-id": "neha" })
        .send({ decision: "APPROVED" });
      expect(qualityApproval.status).toBe(200);
      expect(qualityApproval.body.status).toBe("QUALITY_APPROVED");

      const finalApproval = await api
        .post(`/api/batches/${batchId}/decision`)
        .set(stateOffice)
        .send({ decision: "APPROVED" });
      expect(finalApproval.status).toBe(200);
      expect(finalApproval.body.status).toBe("STATE_APPROVED");

      await vi.waitFor(
        async () => {
          expect(
            await prisma.batch.findUniqueOrThrow({ where: { id: batchId } }).then((batch) => batch.status),
          ).toBe("ISSUED");
        },
        { timeout: 30_000, interval: 100 },
      );
    } finally {
      random.mockRestore();
    }
  }, 45_000);

  it("issues idempotently across delivery retries and revokes verification immediately", async () => {
    const randomValues = [0.1, 0.99, 0.99, 0.99, 0.99, 0.99];
    let randomIndex = 0;
    let simulatedDeliveryFailure = false;
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      const value = randomValues[Math.min(randomIndex++, randomValues.length - 1)];
      if (value < 0.3) simulatedDeliveryFailure = true;
      return value;
    });
    try {
      const uploaded = await uploadBatch("valid-batch.csv", "Retry and revoke");
      expect(uploaded.status).toBe(201);
      const batchId = uploaded.body.id as string;
      await approveDistrictTwice(batchId);
      const finalApproval = await api
        .post(`/api/batches/${batchId}/decision`)
        .set(stateOffice)
        .send({ decision: "APPROVED" });
      expect(finalApproval.status).toBe(200);

      const candidates = await prisma.candidate.findMany({ where: { batchId } });
      await vi.waitFor(
        async () => {
          const sentCount = await prisma.certificate.count({
            where: { batchId, whatsappStatus: "SENT" },
          });
          expect(sentCount).toBe(candidates.length);
        },
        { timeout: 30_000, interval: 100 },
      );

      const certificates = await prisma.certificate.findMany({ where: { batchId } });
      expect(simulatedDeliveryFailure).toBe(true);
      expect(certificates).toHaveLength(candidates.length);
      expect(new Set(certificates.map((certificate) => certificate.certificateNumber)).size)
        .toBe(candidates.length);

      const certificate = certificates[0];
      const validCheck = await api.get(`/api/verify/${certificate.certificateNumber}`);
      expect(validCheck.status).toBe(200);
      expect(validCheck.body.valid).toBe(true);

      const revoke = await api
        .post(`/api/certificates/${certificate.id}/revoke`)
        .set(stateOffice)
        .send({ reason: "Credential record correction" });
      expect(revoke.status).toBe(200);

      const revokedCheck = await api.get(`/api/verify/${certificate.certificateNumber}`);
      expect(revokedCheck.status).toBe(200);
      expect(revokedCheck.body.valid).toBe(false);
      expect(revokedCheck.body.certificate.revokeReason).toBe("Credential record correction");
    } finally {
      random.mockRestore();
    }
  }, 45_000);

  it("deactivates old approvals when a sent-back batch is resubmitted", async () => {
    const uploaded = await uploadBatch("valid-batch.csv", "Resubmission reset");
    expect(uploaded.status).toBe(201);
    const batchId = uploaded.body.id as string;

    const firstApproval = await api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("dev"))
      .send({ decision: "APPROVED" });
    expect(firstApproval.status).toBe(200);

    const sentBack = await api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("meera"))
      .send({ decision: "SENT_BACK", reason: "Correct candidate information" });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body.status).toBe("CHANGES_REQUESTED");

    const updatedCsv = await readFile(fixture("valid-batch.csv"));
    const resubmitted = await api
      .put(`/api/batches/${batchId}/resubmit`)
      .set(centre)
      .attach("file", updatedCsv, "fixed-batch.csv");
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.status).toBe("SUBMITTED");

    const oldApprovals = await prisma.batchApproval.findMany({
      where: { batchId, isActive: true },
    });
    expect(oldApprovals).toHaveLength(0);
    expect(
      await prisma.batchApproval.count({
        where: { batchId, stage: "DISTRICT", decision: "APPROVED", isActive: false },
      }),
    ).toBe(1);

    const newDevApproval = await api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("dev"))
      .send({ decision: "APPROVED" });
    expect(newDevApproval.status).toBe(200);
    expect(newDevApproval.body.status).toBe("SUBMITTED");

    const newMeeraApproval = await api
      .post(`/api/batches/${batchId}/decision`)
      .set(districtOfficer("meera"))
      .send({ decision: "APPROVED" });
    expect(newMeeraApproval.status).toBe(200);
    expect(newMeeraApproval.body.status).toBe("DISTRICT_APPROVED");
    expect(
      await prisma.batchApproval.count({
        where: { batchId, stage: "DISTRICT", decision: "APPROVED", isActive: true },
      }),
    ).toBe(2);
  });
});
