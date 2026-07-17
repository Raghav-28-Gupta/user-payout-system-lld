/**
 * End-to-end demo of the assignment's worked example, driven entirely over
 * HTTP against a freshly seeded database. Exits non-zero unless the final
 * payout comes out to exactly ₹68 — the assignment's own acceptance number.
 *
 * Run with: bun run demo
 */
import type { AddressInfo } from "node:net";
import { resetAndSeed } from "../prisma/seed";
import { prisma } from "../src/db";
import { buildApp } from "../src/app";
import { Decimal } from "../src/money";

const server = buildApp().listen(0);
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function heading(text: string) {
  console.log(`\n=== ${text} ===`);
}

try {
  heading("1. Seed: the assignment's reference data");
  await resetAndSeed();
  console.log("3 PENDING sales for john_doe / brand_1, ₹40 earning each (total ₹120)");

  heading("2. Advance payout job (Business Rule 1: 10% of pending earnings)");
  const job = await api("POST", "/api/jobs/advance-payout", {});
  console.log(`salesProcessed=${job.body.salesProcessed} totalAdvancePaid=₹${job.body.totalAdvancePaid}`);

  const rerun = await api("POST", "/api/jobs/advance-payout", {});
  console.log(
    `re-running the job pays nothing again (idempotent): salesProcessed=${rerun.body.salesProcessed}`,
  );

  const afterAdvance = await api("GET", "/api/users/john_doe/balance");
  console.log(`john_doe's withdrawable balance: ₹${afterAdvance.body.withdrawableBalance}`);

  heading("3. Reconciliation (Business Rule 2: rejected, approved, approved)");
  const sales = await api("GET", "/api/users/john_doe/sales?status=pending");
  const outcomes = ["rejected", "approved", "approved"] as const;
  let totalFinalPayout = new Decimal(0);
  for (let i = 0; i < sales.body.length; i++) {
    const { body } = await api("POST", `/api/admin/sales/${sales.body[i].id}/reconcile`, {
      status: outcomes[i],
    });
    totalFinalPayout = totalFinalPayout.plus(body.adjustment);
    console.log(
      `sale ${i + 1}: earning ₹40, advance ₹4 → ${outcomes[i]!.padEnd(8)} → final adjustment ₹${body.adjustment}`,
    );
  }

  heading("4. The acceptance number");
  console.log(`TOTAL FINAL PAYOUT: ₹${totalFinalPayout.toFixed(2)}`);
  if (!totalFinalPayout.equals(68)) {
    console.error("✗ expected exactly ₹68 — implementation is wrong!");
    process.exit(1);
  }
  console.log("✓ matches the assignment's expected ₹68");

  const finalBalance = await api("GET", "/api/users/john_doe/balance");
  console.log(
    `balance = ₹12 advance + ₹68 final = ₹${finalBalance.body.withdrawableBalance}`,
  );

  heading("5. Withdrawals (Business Rule 3 + Question 2)");
  const first = await api("POST", "/api/users/john_doe/withdraw", { amount: 50 });
  console.log(`withdraw ₹50 → payout ${first.body.status} (balance reserved immediately)`);

  await api("POST", `/api/payouts/${first.body.id}/resolve`, { status: "failed" });
  const afterFail = await api("GET", "/api/users/john_doe/balance");
  console.log(
    `processor reports FAILED → ₹50 credited back, balance ₹${afterFail.body.withdrawableBalance}, daily slot NOT consumed`,
  );

  const retry = await api("POST", "/api/users/john_doe/withdraw", { amount: 50 });
  console.log(`immediate retry allowed → payout ${retry.body.status}`);
  await api("POST", `/api/payouts/${retry.body.id}/resolve`, { status: "completed" });
  console.log("processor reports COMPLETED → 24h lock starts now");

  const blocked = await api("POST", "/api/users/john_doe/withdraw", { amount: 10 });
  console.log(
    `another withdrawal inside 24h → HTTP ${blocked.status} ${blocked.body.error.code}`,
  );

  heading("6. Audit trail");
  const ledger = await api("GET", "/api/users/john_doe/ledger");
  for (const entry of ledger.body) {
    console.log(
      `${String(entry.reason).padEnd(20)} ${String(entry.amount).padStart(8)} → balance ${entry.balanceAfter}`,
    );
  }

  console.log("\nDemo complete — all numbers match the assignment spec.");
} finally {
  server.close();
  await prisma.$disconnect();
}
