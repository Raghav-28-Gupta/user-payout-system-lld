import { describe, expect, test } from "bun:test";
import { Decimal } from "../src/money";
import { ledgerAudit, prisma, resetDb, seedWorkedExample } from "./helpers";
import { AppError } from "../src/errors";
import { createSale } from "../src/services/salesService";
import { runAdvancePayoutJob } from "../src/services/advancePayoutService";
import { reconcileSale } from "../src/services/reconciliationService";
import { initiateWithdrawal, resolveWithdrawal } from "../src/services/withdrawalService";

/** Sets up `alice` with an approved sale so her balance equals `earning`. */
async function aliceWithBalance(earning = 100) {
  const sale = await createSale({
    userId: "alice",
    brand: "brand_1",
    earning: new Decimal(earning),
  });
  await runAdvancePayoutJob("alice");
  await reconcileSale(sale.id, "approved");
  return prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
}

function splitSettled<T>(results: PromiseSettledResult<T>[]) {
  return {
    fulfilled: results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled"),
    rejected: results.filter((r): r is PromiseRejectedResult => r.status === "rejected"),
  };
}

describe("concurrent execution safety (row locks + guards)", () => {
  test("two advance jobs racing pay each sale exactly once", async () => {
    const { user } = await seedWorkedExample();

    const [a, b] = await Promise.all([runAdvancePayoutJob(), runAdvancePayoutJob()]);

    expect(a.salesProcessed + b.salesProcessed).toBe(3);
    expect(await prisma.payout.count({ where: { type: "ADVANCE" } })).toBe(3);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe("12.00");

    const audit = await ledgerAudit(user.id);
    expect(audit.ledgerSum).toBe(audit.balance);
  });

  test("two racing reconciliations of one sale: exactly one wins, the other gets 409", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_1", earning: new Decimal(40) });
    await runAdvancePayoutJob();

    const { fulfilled, rejected } = splitSettled(
      await Promise.allSettled([
        reconcileSale(sale.id, "approved"),
        reconcileSale(sale.id, "rejected"),
      ]),
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(AppError);
    expect((rejected[0]!.reason as AppError).status).toBe(409);

    // Exactly one adjustment was booked, whichever outcome won.
    expect(await prisma.payout.count({ where: { type: "FINAL_ADJUSTMENT" } })).toBe(1);
  });

  test("two racing resolutions of one withdrawal: exactly one wins, the other gets 409", async () => {
    await resetDb();
    const alice = await aliceWithBalance(100);
    const payout = await initiateWithdrawal("alice", new Decimal(50));

    const { fulfilled, rejected } = splitSettled(
      await Promise.allSettled([
        resolveWithdrawal(payout.id, "completed"),
        resolveWithdrawal(payout.id, "failed"),
      ]),
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0]!.reason as AppError).status).toBe(409);

    // Whichever outcome won, money was never created or destroyed.
    const audit = await ledgerAudit(alice.id);
    expect(audit.ledgerSum).toBe(audit.balance);
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    const winnerWasCompleted = fulfilled[0]!.value.status === "COMPLETED";
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe(winnerWasCompleted ? "50.00" : "100.00");
  });

  test("two racing withdrawal initiations cannot double-spend the balance", async () => {
    await resetDb();
    const alice = await aliceWithBalance(100);

    const { fulfilled, rejected } = splitSettled(
      await Promise.allSettled([
        initiateWithdrawal("alice", new Decimal(60)),
        initiateWithdrawal("alice", new Decimal(60)),
      ]),
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // The loser hits either the in-progress guard or the balance guard — both are safe.
    const loser = rejected[0]!.reason as AppError;
    expect([409, 400]).toContain(loser.status);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe("40.00");

    const audit = await ledgerAudit(alice.id);
    expect(audit.ledgerSum).toBe(audit.balance);
  });
});
