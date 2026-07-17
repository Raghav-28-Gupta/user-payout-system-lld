import type { TxClient } from "../db";
import type { LedgerReason, User } from "../../generated/prisma/client";
import type { Decimal } from "../money";

/**
 * The single place where User.withdrawableBalance changes. Applies a signed
 * delta and appends the matching immutable ledger entry, so the balance is
 * always recomputable as sum(LedgerEntry.amount). Must run inside a
 * transaction together with whatever business event caused the movement.
 */
export async function applyLedgerEntry(
  tx: TxClient,
  args: {
    userId: string;
    amount: Decimal;
    reason: LedgerReason;
    saleId?: string;
    payoutId?: string;
  },
): Promise<User> {
  const user = await tx.user.update({
    where: { id: args.userId },
    data: { withdrawableBalance: { increment: args.amount } },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: args.userId,
      amount: args.amount,
      reason: args.reason,
      saleId: args.saleId,
      payoutId: args.payoutId,
      balanceAfter: user.withdrawableBalance,
    },
  });

  return user;
}
