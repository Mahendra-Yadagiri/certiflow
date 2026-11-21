import type { User } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma.js";

declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = req.get("x-user-id");

  if (!userId) {
    return res.status(401).json({ error: "Missing x-user-id header" });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(401).json({ error: "Invalid x-user-id" });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}
