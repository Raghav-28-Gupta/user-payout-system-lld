import { setDefaultTimeout } from "bun:test";

// Hosted Postgres latency: raise the per-test timeout for this file.
setDefaultTimeout(30_000);

import { describe, expect, test } from "bun:test";
import { Decimal } from "../src/money";
import { expectAppError, ledgerAudit, prisma, resetDb } from "./helpers";
import { createSale } from "../src/services/salesService";
import { runAdvancePayoutJob } from "../src/services/advancePayoutService";
import { reconcileSale } from "../src/services/reconciliationService";
import { initiateWithdrawal, resolveWithdrawal } from "../src/services/withdrawalService";

/** Gives `alice` a fully-approved sale so her balance equals `earning`. */
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

/** Pretends alice's last successful withdrawal happened `hours` hours ago. */
async function backdateLastWithdrawal(hours: number) {
  await prisma.user.update({
    where: { username: "alice" },
    data: { lastSuccessfulWithdrawalAt: new Date(Date.now() - hours * 60 * 60 * 1000) },
  });
}

describe("initiating withdrawals (Business Rule 3)", () => {
  test("reserves the amount immediately as a PENDING payout", async () => {
    await resetDb();
    await aliceWithBalance(100);

    const payout = await initiateWithdrawal("alice", new Decimal(60));

    expect(payout.type).toBe("WITHDRAWAL");
    expect(payout.status).toBe("PENDING");
    expect(payout.amount.toFixed(2)).toBe("60.00");

    const alice = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    expect(alice.withdrawableBalance.toFixed(2)).toBe("40.00");
  });

  test("rejects an amount above the available balance (400)", async () => {
    await resetDb();
    await aliceWithBalance(100);

    await expectAppError(
      initiateWithdrawal("alice", new Decimal("100.01")),
      400,
      "INSUFFICIENT_BALANCE",
    );
  });

  test("rejects non-positive amounts (400)", async () => {
    await resetDb();
    await aliceWithBalance(100);

    await expectAppError(initiateWithdrawal("alice", new Decimal(0)), 400, "INVALID_AMOUNT");
    await expectAppError(initiateWithdrawal("alice", new Decimal(-5)), 400, "INVALID_AMOUNT");
  });

  test("404 for an unknown user", async () => {
    await resetDb();
    await expectAppError(initiateWithdrawal("nobody", new Decimal(10)), 404, "USER_NOT_FOUND");
  });

  test("blocks a second withdrawal while one is still PENDING (409)", async () => {
    await resetDb();
    await aliceWithBalance(100);
    await initiateWithdrawal("alice", new Decimal(10));

    await expectAppError(
      initiateWithdrawal("alice", new Decimal(10)),
      409,
      "WITHDRAWAL_IN_PROGRESS",
    );
  });

  test("blocks withdrawals while the balance is ≤ 0 (debt after a rejection)", async () => {
    await resetDb();
    const sale = await createSale({ userId: "alice", brand: "brand_1", earning: new Decimal(100) });
    await runAdvancePayoutJob("alice"); // balance ₹10
    const payout = await initiateWithdrawal("alice", new Decimal(10)); // balance ₹0
    await resolveWithdrawal(payout.id, "completed");
    await reconcileSale(sale.id, "rejected"); // clawback −₹10 → balance −₹10
    await backdateLastWithdrawal(25); // rule out the 24h gate as the blocker

    await expectAppError(initiateWithdrawal("alice", new Decimal(5)), 400, "INSUFFICIENT_BALANCE");
  });
});

describe("the 24-hour window (Business Rule 3)", () => {
  test("a completed withdrawal starts the 24h lock", async () => {
    await resetDb();
    await aliceWithBalance(100);
    const payout = await initiateWithdrawal("alice", new Decimal(10));

    const resolved = await resolveWithdrawal(payout.id, "completed");

    expect(resolved.status).toBe("COMPLETED");
    const alice = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    expect(alice.lastSuccessfulWithdrawalAt).not.toBeNull();

    await expectAppError(initiateWithdrawal("alice", new Decimal(10)), 429, "WITHDRAWAL_LIMIT");
  });

  test("withdrawal is allowed again once 24h have passed", async () => {
    await resetDb();
    await aliceWithBalance(100);
    const payout = await initiateWithdrawal("alice", new Decimal(10));
    await resolveWithdrawal(payout.id, "completed");
    await backdateLastWithdrawal(25);

    const second = await initiateWithdrawal("alice", new Decimal(10));
    expect(second.status).toBe("PENDING");
  });
});

describe("failed payout recovery (Question 2)", () => {
  for (const outcome of ["failed", "cancelled", "rejected"] as const) {
    test(`a ${outcome} withdrawal credits the money back and frees the daily slot`, async () => {
      await resetDb();
      const alice = await aliceWithBalance(100);
      const payout = await initiateWithdrawal("alice", new Decimal(80)); // balance ₹20

      const resolved = await resolveWithdrawal(payout.id, outcome);

      expect(resolved.status).toBe(outcome.toUpperCase() as Uppercase<typeof outcome>);
      const refreshed = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
      expect(refreshed.withdrawableBalance.toFixed(2)).toBe("100.00"); // credited back
      expect(refreshed.lastSuccessfulWithdrawalAt).toBeNull(); // slot never consumed

      // Question 2's explicit requirement: the user can initiate another withdrawal.
      const retry = await initiateWithdrawal("alice", new Decimal(80));
      expect(retry.status).toBe("PENDING");

      const audit = await ledgerAudit(alice.id);
      expect(audit.ledgerSum).toBe(audit.balance);
      expect(audit.chainOk).toBe(true);
    });
  }
});

describe("resolution idempotency", () => {
  test("a payout can only be resolved once — second attempt rejected with 409", async () => {
    await resetDb();
    await aliceWithBalance(100);
    const payout = await initiateWithdrawal("alice", new Decimal(10));
    await resolveWithdrawal(payout.id, "completed");

    await expectAppError(resolveWithdrawal(payout.id, "failed"), 409, "ALREADY_RESOLVED");
  });

  test("only WITHDRAWAL payouts can be resolved (400 for an advance)", async () => {
    await resetDb();
    await createSale({ userId: "alice", brand: "brand_1", earning: new Decimal(100) });
    await runAdvancePayoutJob("alice");
    const advance = await prisma.payout.findFirstOrThrow({ where: { type: "ADVANCE" } });

    await expectAppError(resolveWithdrawal(advance.id, "completed"), 400, "NOT_A_WITHDRAWAL");
  });

  test("404 for an unknown payout id", async () => {
    await resetDb();
    await expectAppError(
      resolveWithdrawal("00000000-0000-0000-0000-000000000000", "completed"),
      404,
      "PAYOUT_NOT_FOUND",
    );
  });
});
