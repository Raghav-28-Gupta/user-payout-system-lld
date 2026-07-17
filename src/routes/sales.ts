import { Router } from "express";
import { z } from "zod";
import { toDecimal } from "../money";
import { createSale } from "../services/salesService";

const createSaleSchema = z.object({
  userId: z.string().min(1),
  brand: z.string().min(1),
  earning: z.union([z.number(), z.string()]),
});

export const salesRouter = Router();

// POST /api/sales — record a pending sale (matches the assignment's reference schema).
salesRouter.post("/", async (req, res) => {
  const input = createSaleSchema.parse(req.body ?? {});
  const sale = await createSale({
    userId: input.userId,
    brand: input.brand,
    earning: toDecimal(input.earning, "earning"),
  });
  res.status(201).json(sale);
});
