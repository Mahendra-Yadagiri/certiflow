import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import cors from "cors";
import express from "express";
import approvalsRouter, { certificatesRouter } from "./routes/approvals.js";
import batchesRouter from "./routes/batches.js";
import eventsRouter from "./routes/events.js";
import verifyRouter from "./routes/verify.js";
import { prisma } from "./prisma.js";
import { startWorkers } from "./worker.js";

export const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/batches", approvalsRouter);
app.use("/api/batches", batchesRouter);
app.use("/api/certificates", certificatesRouter);
app.use("/api/verify", verifyRouter);
app.use("/api/events", eventsRouter);

app.get("/api/users", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { name: "asc" } });
    return res.json(users);
  } catch (error) {
    return next(error);
  }
});

app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Request failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  },
);

export async function startServer() {
  const port = Number(process.env.PORT || 4000);
  if (process.env.RUN_WORKERS !== "false") {
    await startWorkers();
  }
  return app.listen(port, () => {
    console.log(`Certiflow API listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().catch((error: unknown) => {
    console.error("Failed to start Certiflow API:", error);
    process.exitCode = 1;
  });
}
