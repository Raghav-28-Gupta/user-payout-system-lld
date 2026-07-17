import { Router } from "express";
import { z } from "zod";
import { runAdvancePayoutJob } from "../services/advancePayoutService";

const advancePayoutSchema = z.object({
  userId: z.string().min(1).optional(),
});

export const jobsRouter = Router();

// POST /api/jobs/advance-payout — run the advance payout job (all users, or one).
// Exposed as an endpoint instead of a cron scheduler; see README trade-offs.
jobsRouter.post("/advance-payout", async (req, res) => {
  const { userId } = advancePayoutSchema.parse(req.body ?? {});
  res.json(await runAdvancePayoutJob(userId));
});
