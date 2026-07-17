import { prisma, TX_OPTIONS } from "../db";
import { AppError } from "../errors";
import type { Decimal } from "../money";
import { applyLedgerEntry } from "./ledgerService";
import type { Payout, PayoutStatus } from "../../generated/prisma/client";

const WITHDRAWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export type WithdrawalOutcome = "completed" | "failed" | "cancelled" | "rejected";

const OUTCOME_TO_STATUS: Record<WithdrawalOutcome, PayoutStatus> = {
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  rejected: "REJECTED",
};

/**
 * Business Rule 3: one withdrawal per 24 hours, counted against *successful*
 * withdrawals only. The amount is deducted (reserved) immediately so the user
 * cannot double-spend the balance while the payout is in flight. The User row
 * is locked FOR UPDATE, serializing concurrent initiations and resolutions.
 */
export async function initiateWithdrawal(username: string, amount: Decimal): Promise<Payout> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.user.findUnique({ where: { username } });
    if (!found) throw new AppError(404, "USER_NOT_FOUND", `no user named '${username}'`);

    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.id} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });

    if (amount.lte(0)) {
      throw new AppError(400, "INVALID_AMOUNT", "withdrawal amount must be positive");
    }

    const inFlight = await tx.payout.findFirst({
      where: { userId: user.id, type: "WITHDRAWAL", status: "PENDING" },
    });
    if (inFlight) {
      throw new AppError(
        409,
        "WITHDRAWAL_IN_PROGRESS",
        `withdrawal '${inFlight.id}' is still pending; wait for it to resolve first`,
      );
    }

    if (user.withdrawableBalance.lte(0) || amount.gt(user.withdrawableBalance)) {
      throw new AppError(
        400,
        "INSUFFICIENT_BALANCE",
        `withdrawable balance is ₹${user.withdrawableBalance.toFixed(2)}`,
      );
    }

    if (user.lastSuccessfulWithdrawalAt !== null) {
      const elapsed = Date.now() - user.lastSuccessfulWithdrawalAt.getTime();
      if (elapsed < WITHDRAWAL_WINDOW_MS) {
        const retryAfterSeconds = Math.ceil((WITHDRAWAL_WINDOW_MS - elapsed) / 1000);
        throw new AppError(
          429,
          "WITHDRAWAL_LIMIT",
          "only one successful withdrawal is allowed every 24 hours",
          { retryAfterSeconds },
        );
      }
    }

    const payout = await tx.payout.create({
      data: { userId: user.id, type: "WITHDRAWAL", amount, status: "PENDING" },
    });
    await applyLedgerEntry(tx, {
      userId: user.id,
      amount: amount.neg(),
      reason: "WITHDRAWAL_RESERVED",
      payoutId: payout.id,
    });

    return payout;
  }, TX_OPTIONS);
}

/**
 * Question 2: settle an in-flight withdrawal (simulates the payment
 * processor's webhook). `completed` consumes the 24h slot; any failure
 * outcome credits the reserved amount back and leaves the slot untouched,
 * so the user can immediately try again.
 */
export async function resolveWithdrawal(
  payoutId: string,
  outcome: WithdrawalOutcome,
): Promise<Payout> {
  return prisma.$transaction(async (tx) => {
    const found = await tx.payout.findUnique({ where: { id: payoutId } });
    if (!found) throw new AppError(404, "PAYOUT_NOT_FOUND", `no payout with id '${payoutId}'`);
    if (found.type !== "WITHDRAWAL") {
      throw new AppError(
        400,
        "NOT_A_WITHDRAWAL",
        `payout '${payoutId}' is of type ${found.type}; only withdrawals can be resolved`,
      );
    }

    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
    const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
    if (payout.status !== "PENDING") {
      throw new AppError(
        409,
        "ALREADY_RESOLVED",
        `payout '${payoutId}' is already ${payout.status}`,
      );
    }

    const updated = await tx.payout.update({
      where: { id: payoutId },
      data: { status: OUTCOME_TO_STATUS[outcome] },
    });

    if (outcome === "completed") {
      await tx.user.update({
        where: { id: payout.userId },
        data: { lastSuccessfulWithdrawalAt: new Date() },
      });
    } else {
      await applyLedgerEntry(tx, {
        userId: payout.userId,
        amount: payout.amount,
        reason: "WITHDRAWAL_REVERSED",
        payoutId: payout.id,
      });
    }

    return updated;
  }, TX_OPTIONS);
}
