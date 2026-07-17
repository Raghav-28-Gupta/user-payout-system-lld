import express from "express";
import { errorHandler } from "./errors";
import { salesRouter } from "./routes/sales";
import { usersRouter } from "./routes/users";
import { jobsRouter } from "./routes/jobs";
import { adminRouter } from "./routes/admin";
import { payoutsRouter } from "./routes/payouts";

/** App factory (no listen) so tests and the demo can boot it on any port. */
export function buildApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/sales", salesRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/payouts", payoutsRouter);

  app.use(errorHandler);
  return app;
}
