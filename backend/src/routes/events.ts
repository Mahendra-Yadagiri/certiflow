import { Router } from "express";
import { redis } from "../redis.js";

const router = Router();
const eventChannel = "certiflow:events";

router.get("/", async (_req, res, next) => {
  const subscriber = redis.duplicate();
  let closed = false;

  const onMessage = (channel: string, message: string) => {
    if (!closed && channel === eventChannel) {
      res.write(`data: ${message}\n\n`);
    }
  };
  const onError = (error: Error) => {
    console.error("Redis event subscriber error:", error);
    if (!res.headersSent) {
      next(error);
    } else {
      res.end();
    }
  };
  const closeSubscriber = () => {
    if (closed) return;
    closed = true;
    subscriber.off("message", onMessage);
    subscriber.off("error", onError);
    void subscriber.unsubscribe(eventChannel)
      .then(() => subscriber.quit())
      .catch((error: unknown) => {
        console.error("Failed to close Redis event subscriber:", error);
      });
  };

  subscriber.on("message", onMessage);
  subscriber.on("error", onError);
  res.on("close", closeSubscriber);

  try {
    await subscriber.subscribe(eventChannel);
  } catch (error) {
    closeSubscriber();
    return next(error);
  }

  if (closed) return;

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
});

export default router;
