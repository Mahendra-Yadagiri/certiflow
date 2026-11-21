import { Router } from "express";
import { prisma } from "../prisma.js";
import { redis } from "../redis.js";

const router = Router();

router.get("/:certificateNumber", async (req, res, next) => {
  const cacheKey = `verify:${req.params.certificateNumber}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return res.json(JSON.parse(cached));
      } catch {
        await redis.del(cacheKey);
      }
    }

    const certificate = await prisma.certificate.findUnique({
      where: { certificateNumber: req.params.certificateNumber },
      include: { candidate: true, batch: true },
    });
    const result = {
      valid: certificate?.status === "VALID",
      certificate,
    };

    await redis.set(cacheKey, JSON.stringify(result), "EX", 60);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
