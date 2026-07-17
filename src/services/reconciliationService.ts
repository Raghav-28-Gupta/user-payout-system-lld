import { prisma, TX_OPTIONS } from "../db";
import { AppError } from "../errors";
import { applyLedgerEntry } from "./ledgerService";
import type { Sale } from "../../generated/prisma/client";

export type ReconcileOutcome = "approved" | "rejected";

/**
 * Business Rule 2: settle a pending sale.
 *   approved → pay the remainder: earning − advance already paid
 *   rejected → claw the advance back: −advancePaid
 * Only PENDING sales can transition; the row is locked FOR UPDATE and the
 * status re-checked so a concurrent/second attempt gets a 409, never a
 * double adjustment.
 */
export async function reconcileSale(
  saleId: string,
  outcome: ReconcileOutcome,
): Promise<{ sale: Sale; adjustment: string }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;

    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale) throw new AppError(404, "SALE_NOT_FOUND", `no sale with id '${saleId}'`);
    if (sale.status !== "PENDING") {
      throw new AppError(
        409,
        "ALREADY_RECONCILED",
        `sale '${saleId}' is already ${sale.status}; only PENDING sales can be reconciled`,
      );
    }

    const adjustment =
      outcome === "approved" ? sale.earning.minus(sale.advancePaid) : sale.advancePaid.neg();

    const updated = await tx.sale.update({
      where: { id: saleId },
      data: {
        status: outcome === "approved" ? "APPROVED" : "REJECTED",
        reconciledAt: new Date(),
      },
    });

    if (!adjustment.isZero()) {
      const payout = await tx.payout.create({
        data: {
          userId: sale.userId,
          saleId: sale.id,
          type: "FINAL_ADJUSTMENT",
          amount: adjustment,
          status: "COMPLETED",
        },
      });
      await applyLedgerEntry(tx, {
        userId: sale.userId,
        amount: adjustment,
        reason: "FINAL_ADJUSTMENT",
        saleId: sale.id,
        payoutId: payout.id,
      });
    }

    return { sale: updated, adjustment: adjustment.toFixed(2) };
  }, TX_OPTIONS);
}
