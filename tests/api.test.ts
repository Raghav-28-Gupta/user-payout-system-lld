import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { resetDb } from "./helpers";
import { buildApp } from "../src/app";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  server = buildApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const responseBody = (await response.json()) as any;
  return { status: response.status, headers: response.headers, body: responseBody };
}

describe("worked example over HTTP", () => {
  test("reproduces ₹12 advance and ₹68 final payout end-to-end", async () => {
    await resetDb();

    // Three pending sales, ₹40 each — the assignment's reference data.
    for (let i = 0; i < 3; i++) {
      const created = await api("POST", "/api/sales", {
        userId: "john_doe",
        brand: "brand_1",
        earning: 40,
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("PENDING");
      expect(created.body.earning).toBe("40");
    }

    // Advance payout job: 10% of ₹120 = ₹12.
    const job = await api("POST", "/api/jobs/advance-payout", {});
    expect(job.status).toBe(200);
    expect(job.body).toEqual({ salesProcessed: 3, totalAdvancePaid: "12.00" });

    const balanceAfterAdvance = await api("GET", "/api/users/john_doe/balance");
    expect(balanceAfterAdvance.body.withdrawableBalance).toBe("12.00");

    // Reconcile: rejected, approved, approved.
    const sales = await api("GET", "/api/users/john_doe/sales?status=pending");
    expect(sales.status).toBe(200);
    expect(sales.body.length).toBe(3);

    const outcomes = ["rejected", "approved", "approved"] as const;
    const adjustments: string[] = [];
    for (let i = 0; i < 3; i++) {
      const reconciled = await api("POST", `/api/admin/sales/${sales.body[i].id}/reconcile`, {
        status: outcomes[i],
      });
      expect(reconciled.status).toBe(200);
      adjustments.push(reconciled.body.adjustment);
    }
    expect(adjustments).toEqual(["-4.00", "36.00", "36.00"]); // sums to ₹68

    // Final balance: ₹12 advance + ₹68 final payout = ₹80.
    const finalBalance = await api("GET", "/api/users/john_doe/balance");
    expect(finalBalance.body.withdrawableBalance).toBe("80.00");

    // Audit trail: 3 advances + 3 adjustments.
    const ledger = await api("GET", "/api/users/john_doe/ledger");
    expect(ledger.status).toBe(200);
    expect(ledger.body.length).toBe(6);
    expect(ledger.body[5].balanceAfter).toBe("80");
  });
});

describe("withdrawal flow over HTTP", () => {
  test("withdraw, fail, retry — Question 2 end-to-end", async () => {
    // State carried over from the worked example test: balance ₹80.
    const first = await api("POST", "/api/users/john_doe/withdraw", { amount: 50 });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("PENDING");

    const reserved = await api("GET", "/api/users/john_doe/balance");
    expect(reserved.body.withdrawableBalance).toBe("30.00");

    const failed = await api("POST", `/api/payouts/${first.body.id}/resolve`, {
      status: "failed",
    });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("FAILED");

    const creditedBack = await api("GET", "/api/users/john_doe/balance");
    expect(creditedBack.body.withdrawableBalance).toBe("80.00");

    // Slot was never consumed — retry succeeds immediately, then completes.
    const retry = await api("POST", "/api/users/john_doe/withdraw", { amount: 50 });
    expect(retry.status).toBe(201);
    const completed = await api("POST", `/api/payouts/${retry.body.id}/resolve`, {
      status: "completed",
    });
    expect(completed.status).toBe(200);

    // Now the 24h gate applies.
    const blocked = await api("POST", "/api/users/john_doe/withdraw", { amount: 10 });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("WITHDRAWAL_LIMIT");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("validation and error shapes", () => {
  test("malformed sale body → 400 VALIDATION_ERROR", async () => {
    const response = await api("POST", "/api/sales", { userId: "x" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("unknown user → 404 with error envelope", async () => {
    const response = await api("GET", "/api/users/ghost/balance");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("USER_NOT_FOUND");
  });

  test("invalid reconcile status → 400", async () => {
    const response = await api("POST", "/api/admin/sales/some-id/reconcile", {
      status: "maybe",
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
