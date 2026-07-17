import { setDefaultTimeout } from "bun:test";

// Hosted Postgres latency: raise the per-test timeout for this file.
setDefaultTimeout(30_000);

import { describe, expect, test } from "bun:test";
import { Decimal } from "../src/money";
import { expectAppError, ledgerAudit, prisma, resetDb, seedWorkedExample } from "./helpers";
import { runAdvancePayoutJob } from "../src/services/advancePayoutService";
import { reconcileSale } from "../src/services/reconciliationService";
import { createSale } from "../src/services/salesService";

describe("advance payout job (Business Rule 1)", () => {
  test("pays a 10% advance on every pending sale — ₹12 total for the worked example", async () => {
    const { user } = await seedWorkedExample();

    const result = await runAdvancePayoutJob();

    expect(result.salesProcessed).toBe(3);
    expect(result.totalAdvancePaid).toBe("12.00");

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe("12.00");

    const sales = await prisma.sale.findMany();
    for (const sale of sales) {
      expect(sale.advancePaid.toFixed(2)).toBe("4.00");
      expect(sale.advancePaidAt).not.toBeNull();
    }
  });

  test("running the job twice never pays the same sale twice (idempotency)", async () => {
    const { user } = await seedWorkedExample();

    await runAdvancePayoutJob();
    const second = await runAdvancePayoutJob();

    expect(second.salesProcessed).toBe(0);
    expect(second.totalAdvancePaid).toBe("0.00");

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe("12.00");
  });

  test("can be scoped to a single user", async () => {
    await resetDb();
    await createSale({ userId: "alice", brand: "brand_1", earning: new Decimal(100) });
    await createSale({ userId: "bob", brand: "brand_2", earning: new Decimal(200) });

    const result = await runAdvancePayoutJob("alice");

    expect(result.salesProcessed).toBe(1);
    expect(result.totalAdvancePaid).toBe("10.00");

    const bob = await prisma.user.findUniqueOrThrow({ where: { username: "bob" } });
    expect(bob.withdrawableBalance.isZero()).toBe(true);
  });
});

describe("reconciliation (Business Rule 2)", () => {
  test("approved sale pays the remaining earning − advance (Case 1: ₹30 − ₹3 = ₹27)", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_2", earning: new Decimal(30) });
    await runAdvancePayoutJob();

    const { adjustment } = await reconcileSale(sale.id, "approved");

    expect(adjustment).toBe("27.00");
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    expect(user.withdrawableBalance.toFixed(2)).toBe("30.00"); // ₹3 advance + ₹27 final
  });

  test("rejected sale claws back the advance (Case 2: adjustment −₹5)", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_2", earning: new Decimal(50) });
    await runAdvancePayoutJob();

    const { adjustment } = await reconcileSale(sale.id, "rejected");

    expect(adjustment).toBe("-5.00");
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    expect(user.withdrawableBalance.toFixed(2)).toBe("0.00"); // ₹5 advance − ₹5 clawback
  });

  test("rejecting a sale that never got an advance is a ₹0 no-op", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_2", earning: new Decimal(40) });

    const { adjustment } = await reconcileSale(sale.id, "rejected");

    expect(adjustment).toBe("0.00");
    const adjustments = await prisma.payout.count({ where: { type: "FINAL_ADJUSTMENT" } });
    expect(adjustments).toBe(0);
  });

  test("a sale can only be reconciled once — second attempt rejected with 409", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_2", earning: new Decimal(40) });
    await reconcileSale(sale.id, "approved");

    await expectAppError(reconcileSale(sale.id, "rejected"), 409, "ALREADY_RECONCILED");
  });

  test("worked example: total advance ₹12, final payout ₹68", async () => {
    const { user } = await seedWorkedExample();

    const job = await runAdvancePayoutJob();
    expect(job.totalAdvancePaid).toBe("12.00");

    const sales = await prisma.sale.findMany({ orderBy: { createdAt: "asc" } });
    expect(sales.length).toBe(3);
    const outcomes = ["rejected", "approved", "approved"] as const;
    const adjustments: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { adjustment } = await reconcileSale(sales[i]!.id, outcomes[i]!);
      adjustments.push(adjustment);
    }

    expect(adjustments).toEqual(["-4.00", "36.00", "36.00"]);

    const totalFinalPayout = adjustments.reduce(
      (sum, a) => sum.plus(new Decimal(a)),
      new Decimal(0),
    );
    expect(totalFinalPayout.toFixed(2)).toBe("68.00"); // ← the assignment's own acceptance number

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.withdrawableBalance.toFixed(2)).toBe("80.00"); // ₹12 advance + ₹68 final

    const audit = await ledgerAudit(user.id);
    expect(audit.ledgerSum).toBe(audit.balance);
    expect(audit.chainOk).toBe(true);
  });
});
