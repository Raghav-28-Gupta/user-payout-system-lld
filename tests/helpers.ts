import { expect } from "bun:test";
import { prisma } from "../src/db";
import { resetAndSeed } from "../prisma/seed";
import { Decimal } from "../src/money";
import { AppError } from "../src/errors";

export { prisma };

/** Asserts that a promise rejects with an AppError carrying the given status (and code, if provided). */
export async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.status).toBe(status);
    if (code !== undefined) expect(appError.code).toBe(code);
    return;
  }
  throw new Error(`expected AppError(${status}) but the promise resolved`);
}

/** Wipe every table (FK-safe order). Tests own the database contents. */
export async function resetDb() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.user.deleteMany();
}

/** Seed the assignment's exact worked example (john_doe, brand_1, 3 × ₹40 PENDING). */
export const seedWorkedExample = resetAndSeed;

/**
 * Audit a user's ledger: the sum of all entry deltas must equal the stored
 * balance, and each entry's balanceAfter must chain from the previous one.
 */
export async function ledgerAudit(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const entries = await prisma.ledgerEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  let running = new Decimal(0);
  let chainOk = true;
  for (const entry of entries) {
    running = running.plus(entry.amount);
    if (!entry.balanceAfter.equals(running)) chainOk = false;
  }

  return {
    balance: user.withdrawableBalance.toFixed(2),
    ledgerSum: running.toFixed(2),
    chainOk,
  };
}
