import { prisma } from "../db";
import { Decimal, advanceOn } from "../money";
import { applyLedgerEntry } from "./ledgerService";
import { requireUser } from "./userService";

/**
 * Business Rule 1: every PENDING sale gets a one-time advance of 10% of its
 * earnings. Each sale is settled in its own transaction so a crash mid-run
 * leaves already-paid sales consistent, and re-running the job (or running
 * it concurrently) can never pay the same sale twice: the row is locked
 * with FOR UPDATE and the `advancePaidAt IS NULL` guard is re-checked after
 * acquiring the lock.
 */
export async function runAdvancePayoutJob(
  username?: string,
): Promise<{ salesProcessed: number; totalAdvancePaid: string }> {
  const userId = username !== undefined ? (await requireUser(username)).id : undefined;

  const candidates = await prisma.sale.findMany({
    where: { status: "PENDING", advancePaidAt: null, ...(userId && { userId }) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let salesProcessed = 0;
  let totalAdvancePaid = new Decimal(0);

  for (const { id } of candidates) {
    const paid = await payAdvanceForSale(id);
    if (paid !== null) {
      salesProcessed += 1;
      totalAdvancePaid = totalAdvancePaid.plus(paid);
    }
  }

  return { salesProcessed, totalAdvancePaid: totalAdvancePaid.toFixed(2) };
}

/** Pays the advance for one sale. Returns the amount, or null if the sale was already handled. */
async function payAdvanceForSale(saleId: string): Promise<Decimal | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;

    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale || sale.status !== "PENDING" || sale.advancePaidAt !== null) return null;

    const advance = advanceOn(sale.earning);
    const now = new Date();

    await tx.sale.update({
      where: { id: saleId },
      data: { advancePaid: advance, advancePaidAt: now },
    });

    if (advance.isZero()) return advance;

    const payout = await tx.payout.create({
      data: {
        userId: sale.userId,
        saleId: sale.id,
        type: "ADVANCE",
        amount: advance,
        status: "COMPLETED",
      },
    });
    await applyLedgerEntry(tx, {
      userId: sale.userId,
      amount: advance,
      reason: "ADVANCE_PAYOUT",
      saleId: sale.id,
      payoutId: payout.id,
    });

    return advance;
  });
}
