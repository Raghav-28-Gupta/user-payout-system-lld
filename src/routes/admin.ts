import { Router } from "express";
import { z } from "zod";
import { reconcileSale } from "../services/reconciliationService";

const reconcileSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

export const adminRouter = Router();

// POST /api/admin/sales/:saleId/reconcile — settle a pending sale.
adminRouter.post("/sales/:saleId/reconcile", async (req, res) => {
  const { status } = reconcileSchema.parse(req.body ?? {});
  res.json(await reconcileSale(req.params.saleId, status));
});
