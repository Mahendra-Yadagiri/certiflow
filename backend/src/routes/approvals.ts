import { Queue } from "bullmq";
import type { Batch, User } from "@prisma/client";
import { Router, type RequestHandler } from "express";
import { parse } from "csv-parse/sync";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../middleware/auth.js";
import { prisma } from "../prisma.js";
import { redis } from "../redis.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const eventChannel = "certiflow:events";
const issuanceQueue = new Queue("cert-issuance", {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  },
});

export async function closeApprovalQueue() {
  await issuanceQueue.close();
}

const decisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "SENT_BACK"]),
  reason: z.string().trim().min(1).optional(),
});

const candidateSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().regex(/^\d{10}$/, "Phone must contain exactly 10 digits"),
  rollNumber: z.string().min(1),
});

type CandidateInput = z.infer<typeof candidateSchema>;
type UploadError = { row: number; field: string; message: string };
type LockedBatch = Pick<
  Batch,
  "id" | "centreId" | "district" | "status" | "candidateCount"
>;

function parseCandidates(buffer: Buffer): {
  candidates: CandidateInput[];
  errors: UploadError[];
} {
  let records: Record<string, string>[];
  try {
    records = parse(buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    return {
      candidates: [],
      errors: [
        {
          row: 1,
          field: "csv",
          message: error instanceof Error ? error.message : "Invalid CSV file",
        },
      ],
    };
  }

  if (records.length === 0) {
    return {
      candidates: [],
      errors: [
        { row: 1, field: "csv", message: "CSV must contain at least one candidate" },
      ],
    };
  }

  const candidates: CandidateInput[] = [];
  const errors: UploadError[] = [];
  const rollNumberRows = new Map<string, number[]>();

  records.forEach((record, index) => {
    const row = index + 2;
    if (typeof record.rollNumber === "string" && record.rollNumber.length > 0) {
      const rows = rollNumberRows.get(record.rollNumber) ?? [];
      rows.push(row);
      rollNumberRows.set(record.rollNumber, rows);
    }

    const result = candidateSchema.safeParse(record);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          row,
          field: String(issue.path[0] ?? "csv"),
          message: issue.message,
        });
      }
      return;
    }

    candidates.push(result.data);
  });

  for (const [rollNumber, rows] of rollNumberRows) {
    if (rows.length > 1) {
      for (const row of rows) {
        errors.push({
          row,
          field: "rollNumber",
          message: `Roll number "${rollNumber}" must be unique in the file`,
        });
      }
    }
  }

  return { candidates, errors };
}

const parseUpload: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error?: unknown) => {
    if (error) {
      return res.status(400).json({
        errors: [
          {
            row: 1,
            field: "file",
            message:
              error instanceof Error ? error.message : "Unable to process uploaded file",
          },
        ],
      });
    }
    return next();
  });
};

function approvalStage(batch: LockedBatch): "DISTRICT" | "QUALITY" | "STATE" | null {
  if (batch.status === "SUBMITTED") return "DISTRICT";
  if (batch.status === "DISTRICT_APPROVED") {
    return batch.candidateCount > 30 ? "QUALITY" : "STATE";
  }
  if (batch.status === "QUALITY_APPROVED") return "STATE";
  return null;
}

function canReview(batch: LockedBatch, user: User): boolean {
  switch (approvalStage(batch)) {
    case "DISTRICT":
      return user.role === "DISTRICT_OFFICER" && user.district === batch.district;
    case "QUALITY":
      return user.role === "QUALITY_TEAM";
    case "STATE":
      return user.role === "STATE_OFFICE";
    default:
      return false;
  }
}

router.post("/:id/decision", authenticate, async (req, res, next) => {
  const parsedDecision = decisionSchema.safeParse(req.body);
  if (!parsedDecision.success) {
    return res.status(400).json({
      errors: parsedDecision.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? "decision"),
        message: issue.message,
      })),
    });
  }

  const { decision, reason } = parsedDecision.data;
  if (decision !== "APPROVED" && !reason) {
    return res.status(400).json({
      errors: [
        {
          field: "reason",
          message: "A reason is required for rejection or sending a batch back",
        },
      ],
    });
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const [batch] = await transaction.$queryRaw<LockedBatch[]>`
        SELECT * FROM "Batch" WHERE id = ${req.params.id} FOR UPDATE
      `;

      if (!batch) return { kind: "not_found" as const };
      if (!canReview(batch, req.user)) return { kind: "forbidden" as const };

      const stage = approvalStage(batch);
      if (!stage) return { kind: "invalid_status" as const };

      const nextStatus =
        decision === "REJECTED"
          ? "REJECTED"
          : decision === "SENT_BACK"
            ? "CHANGES_REQUESTED"
            : null;

      if (stage === "DISTRICT" && decision === "APPROVED") {
        const existingApproval = await transaction.batchApproval.findFirst({
          where: {
            batchId: batch.id,
            officerId: req.user.id,
            stage: "DISTRICT",
            isActive: true,
          },
        });
        if (existingApproval) return { kind: "already_approved" as const };
      }

      await transaction.batchApproval.create({
        data: {
          batchId: batch.id,
          officerId: req.user.id,
          stage,
          decision,
          reason: reason ?? null,
        },
      });

      let candidateIds: string[] = [];

      if (nextStatus) {
        await transaction.batch.update({
          where: { id: batch.id },
          data: { status: nextStatus },
        });
      } else if (stage === "DISTRICT") {
        const approvalCount = await transaction.batchApproval.count({
          where: {
            batchId: batch.id,
            stage: "DISTRICT",
            decision: "APPROVED",
            isActive: true,
          },
        });
        if (approvalCount >= 2 && batch.status === "SUBMITTED") {
          await transaction.batch.update({
            where: { id: batch.id },
            data: { status: "DISTRICT_APPROVED" },
          });
        }
      } else if (stage === "QUALITY") {
        await transaction.batch.update({
          where: { id: batch.id },
          data: { status: "QUALITY_APPROVED" },
        });
      } else {
        await transaction.batch.update({
          where: { id: batch.id },
          data: { status: "STATE_APPROVED" },
        });
        const candidates = await transaction.candidate.findMany({
          where: { batchId: batch.id },
          select: { id: true },
        });
        candidateIds = candidates.map((candidate) => candidate.id);
      }

      await transaction.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: batch.id,
          actorId: req.user.id,
          action:
            decision === "APPROVED"
              ? "BATCH_APPROVED"
              : decision === "REJECTED"
                ? "BATCH_REJECTED"
                : "BATCH_SENT_BACK",
          metadata: { decision, stage, reason: reason ?? null },
        },
      });

      const updatedBatch = await transaction.batch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      return { kind: "ok" as const, batch: updatedBatch, candidateIds, decision };
    });

    if (result.kind === "not_found") {
      return res.status(404).json({ error: "Batch not found" });
    }
    if (result.kind === "forbidden") {
      return res.status(403).json({ error: "You cannot review this batch at its current stage" });
    }
    if (result.kind === "invalid_status") {
      return res.status(409).json({ error: "Batch is not awaiting a decision" });
    }
    if (result.kind === "already_approved") {
      return res.status(409).json({ error: "You have already approved this batch" });
    }

    if (result.candidateIds.length > 0) {
      await issuanceQueue.addBulk(
        result.candidateIds.map((candidateId) => ({
          name: "issue-certificate",
          data: { batchId: result.batch.id, candidateId },
          opts: {
            jobId: `cert-${result.batch.id}-${candidateId}`,
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
          },
        })),
      );
    }

    await redis.publish(
      eventChannel,
      JSON.stringify({
        type: "BATCH_DECISION",
        batchId: result.batch.id,
        status: result.batch.status,
        decision: result.decision,
      }),
    );

    return res.json(result.batch);
  } catch (error) {
    return next(error);
  }
});

router.put("/:id/resubmit", authenticate, parseUpload, async (req, res, next) => {
  if (req.user.role !== "CENTRE") {
    return res.status(403).json({ error: "Only centres can resubmit batches" });
  }
  if (!req.file) {
    return res.status(400).json({
      errors: [{ row: 1, field: "file", message: "A CSV file is required" }],
    });
  }

  const { candidates, errors } = parseCandidates(req.file.buffer);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const [batch] = await transaction.$queryRaw<LockedBatch[]>`
        SELECT * FROM "Batch" WHERE id = ${req.params.id} FOR UPDATE
      `;
      if (!batch) return { kind: "not_found" as const };
      if (batch.centreId !== req.user.id) return { kind: "forbidden" as const };
      if (batch.status !== "CHANGES_REQUESTED") return { kind: "invalid_status" as const };

      const certificates = await transaction.certificate.count({
        where: { batchId: batch.id },
      });
      if (certificates > 0) return { kind: "has_certificates" as const };

      await transaction.batchApproval.updateMany({
        where: { batchId: batch.id, isActive: true },
        data: { isActive: false },
      });
      await transaction.candidate.deleteMany({ where: { batchId: batch.id } });
      await transaction.candidate.createMany({
        data: candidates.map((candidate) => ({ ...candidate, batchId: batch.id })),
      });

      const updatedBatch = await transaction.batch.update({
        where: { id: batch.id },
        data: { status: "SUBMITTED", candidateCount: candidates.length },
      });

      await transaction.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: batch.id,
          actorId: req.user.id,
          action: "BATCH_RESUBMITTED",
          metadata: { candidateCount: candidates.length },
        },
      });

      return { kind: "ok" as const, batch: updatedBatch };
    });

    if (result.kind === "not_found") {
      return res.status(404).json({ error: "Batch not found" });
    }
    if (result.kind === "forbidden") {
      return res.status(403).json({ error: "You do not own this batch" });
    }
    if (result.kind === "invalid_status") {
      return res.status(409).json({ error: "Only batches requesting changes can be resubmitted" });
    }
    if (result.kind === "has_certificates") {
      return res.status(409).json({ error: "Cannot replace candidates for a batch with certificates" });
    }

    await redis.publish(
      eventChannel,
      JSON.stringify({ type: "BATCH_RESUBMITTED", batch: result.batch }),
    );
    return res.json(result.batch);
  } catch (error) {
    return next(error);
  }
});

export const certificatesRouter = Router();
certificatesRouter.use(authenticate);

certificatesRouter.post("/:id/revoke", async (req, res, next) => {
  if (req.user.role !== "STATE_OFFICE") {
    return res.status(403).json({ error: "Only the state office can revoke certificates" });
  }

  const input = z.object({ reason: z.string().trim().min(1) }).safeParse(req.body);
  if (!input.success) {
    return res.status(400).json({
      errors: input.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? "reason"),
        message: issue.message,
      })),
    });
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const certificate = await transaction.certificate.findUnique({
        where: { id: req.params.id },
      });
      if (!certificate) return null;

      const revoked = await transaction.certificate.update({
        where: { id: certificate.id },
        data: {
          status: "REVOKED",
          revokedAt: new Date(),
          revokedBy: req.user.id,
          revokeReason: input.data.reason,
        },
      });
      await transaction.auditLog.create({
        data: {
          entityType: "Certificate",
          entityId: certificate.id,
          actorId: req.user.id,
          action: "CERTIFICATE_REVOKED",
          metadata: { reason: input.data.reason, certificateNumber: certificate.certificateNumber },
        },
      });
      return revoked;
    });

    if (!result) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    await redis.del(`verify:${result.certificateNumber}`);
    await redis.publish(
      eventChannel,
      JSON.stringify({ type: "CERTIFICATE_REVOKED", certificate: result }),
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
