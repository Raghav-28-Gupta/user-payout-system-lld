import { Router } from "express";
import { z } from "zod";
import { resolveWithdrawal } from "../services/withdrawalService";

const resolveSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled", "rejected"]),
});

export const payoutsRouter = Router();

// POST /api/payouts/:payoutId/resolve — simulates the payment processor's
// webhook telling us how an in-flight withdrawal ended.
payoutsRouter.post("/:payoutId/resolve", async (req, res) => {
  const { status } = resolveSchema.parse(req.body ?? {});
  res.json(await resolveWithdrawal(req.params.payoutId, status));
});
