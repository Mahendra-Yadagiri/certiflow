import type { Prisma, User } from "@prisma/client";
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

const candidateSchema = z.object({
  fullName: z.string().min(2),
  phone: z.string().regex(/^\d{10}$/, "Phone must contain exactly 10 digits"),
  rollNumber: z.string().min(1),
});

type UploadError = {
  row: number;
  field: string;
  message: string;
};

function visibleBatchesWhere(user: User): Prisma.BatchWhereInput {
  switch (user.role) {
    case "CENTRE":
      return { centreId: user.id };
    case "DISTRICT_OFFICER":
      return user.district ? { district: user.district } : { id: "" };
    case "QUALITY_TEAM":
      return { candidateCount: { gt: 30 } };
    case "STATE_OFFICE":
      return {};
  }
}

const parseUpload: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (error?: unknown) => {
    if (error) {
      const message =
        error instanceof Error ? error.message : "Unable to process uploaded file";
      return res.status(400).json({
        errors: [{ row: 1, field: "file", message }],
      });
    }

    return next();
  });
};

router.use(authenticate);

router.post("/upload", parseUpload, async (req, res, next) => {
  if (req.user.role !== "CENTRE") {
    return res.status(403).json({ error: "Only centres can upload batches" });
  }

  if (!req.file) {
    return res.status(400).json({
      errors: [{ row: 1, field: "file", message: "A CSV file is required" }],
    });
  }

  const courseNameResult = z.string().trim().min(1).safeParse(req.body.courseName);
  if (!courseNameResult.success) {
    return res.status(400).json({
      errors: [
        {
          row: 1,
          field: "courseName",
          message: "A course name is required",
        },
      ],
    });
  }

  if (!req.user.district) {
    return res.status(400).json({
      errors: [
        {
          row: 1,
          field: "district",
          message: "The centre must have a district assigned",
        },
      ],
    });
  }

  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid CSV file";
    return res.status(400).json({
      errors: [{ row: 1, field: "csv", message }],
    });
  }

  if (records.length === 0) {
    return res.status(400).json({
      errors: [
        { row: 1, field: "csv", message: "CSV must contain at least one candidate" },
      ],
    });
  }

  const errors: UploadError[] = [];
  const candidates: z.infer<typeof candidateSchema>[] = [];

  records.forEach((record, index) => {
    const result = candidateSchema.safeParse(record);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          row: index + 2,
          field: String(issue.path[0] ?? "csv"),
          message: issue.message,
        });
      }
      return;
    }
    candidates.push(result.data);
  });

  const rollNumberCounts = new Map<string, number>();
  for (const record of records) {
    if (typeof record.rollNumber === "string" && record.rollNumber.length > 0) {
      rollNumberCounts.set(
        record.rollNumber,
        (rollNumberCounts.get(record.rollNumber) ?? 0) + 1,
      );
    }
  }
  records.forEach((record, index) => {
    if (
      typeof record.rollNumber === "string" &&
      (rollNumberCounts.get(record.rollNumber) ?? 0) > 1
    ) {
      errors.push({
        row: index + 2,
        field: "rollNumber",
        message: "Roll number must be unique in the uploaded file",
      });
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  try {
    const batch = await prisma.$transaction(async (transaction) => {
      const createdBatch = await transaction.batch.create({
        data: {
          centreId: req.user.id,
          district: req.user.district,
          courseName: courseNameResult.data,
          status: "SUBMITTED",
          candidateCount: candidates.length,
        },
      });

      await transaction.candidate.createMany({
        data: candidates.map((candidate) => ({
          ...candidate,
          batchId: createdBatch.id,
        })),
      });

      await transaction.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: createdBatch.id,
          actorId: req.user.id,
          action: "BATCH_SUBMITTED",
          metadata: { candidateCount: candidates.length },
        },
      });

      return createdBatch;
    });

    await redis.publish(
      eventChannel,
      JSON.stringify({ type: "BATCH_SUBMITTED", batch }),
    );

    return res.status(201).json(batch);
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const batches = await prisma.batch.findMany({
      where: visibleBatchesWhere(req.user),
      orderBy: { createdAt: "desc" },
    });
    return res.json(batches);
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const batch = await prisma.batch.findFirst({
      where: {
        id: req.params.id,
        ...visibleBatchesWhere(req.user),
      },
      include: {
        candidates: true,
        approvals: true,
        certificates: true,
      },
    });

    if (!batch) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: "Batch", entityId: batch.id },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ ...batch, auditLogs });
  } catch (error) {
    return next(error);
  }
});

export default router;
