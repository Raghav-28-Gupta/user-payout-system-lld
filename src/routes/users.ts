import { Router } from "express";
import { z } from "zod";
import { toDecimal } from "../money";
import { listSales } from "../services/salesService";
import { getBalance, getLedger } from "../services/userService";
import { initiateWithdrawal } from "../services/withdrawalService";
import type { SaleStatus } from "../../generated/prisma/client";

const listSalesQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

const withdrawSchema = z.object({
  amount: z.union([z.number(), z.string()]),
});

export const usersRouter = Router();

// GET /api/users/:username/sales?status=pending|approved|rejected
usersRouter.get("/:username/sales", async (req, res) => {
  const { status } = listSalesQuerySchema.parse(req.query);
  const sales = await listSales(
    req.params.username,
    status?.toUpperCase() as SaleStatus | undefined,
  );
  res.json(sales);
});

// GET /api/users/:username/balance
usersRouter.get("/:username/balance", async (req, res) => {
  res.json(await getBalance(req.params.username));
});

// POST /api/users/:username/withdraw — initiate a 24h-gated withdrawal.
usersRouter.post("/:username/withdraw", async (req, res) => {
  const { amount } = withdrawSchema.parse(req.body ?? {});
  const payout = await initiateWithdrawal(req.params.username, toDecimal(amount, "amount"));
  res.status(201).json(payout);
});

// GET /api/users/:username/ledger — full audit trail.
usersRouter.get("/:username/ledger", async (req, res) => {
  res.json(await getLedger(req.params.username));
});
