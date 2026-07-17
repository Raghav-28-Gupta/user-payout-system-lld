## 1. Executive Summary

Build a Low-Level Design + working implementation of a **User Payout Management System** for affiliate sales. Sales start `Pending` and are immediately eligible for a 10% "advance payout." Later, an admin reconciles each sale to `Approved` or `Rejected`, at which point the system computes a final payout adjustment that accounts for the advance already paid. Users can withdraw their accumulated balance, but only once every 24 hours — and if a withdrawal later fails/is cancelled/rejected, the money must be credited back and the user allowed to try again.

**Deadline:** July 19, 6:00 PM. **Key ambiguities and how they were resolved** (see full list in §3 — Design Decisions):

- Web framework not specified by the assignment (only "JS or Python" + your Bun/Prisma choice) → **Express.js** chosen for Bun-native fit.
- Whether the 24h withdrawal lock applies to _attempts_ or _successful_ withdrawals → resolved as **successful withdrawals only**, so a failed attempt doesn't burn the user's daily slot (directly required by Question 2's "allow the user to initiate another withdrawal").
- Withdrawal amount: assumed **user-specified amount up to available balance**, not forced full-balance withdrawal.
- Advance payout job exposed as a **callable endpoint** rather than a real cron scheduler (acceptable for a take-home; note this as a trade-off in the README).

---

## 2. Full Problem Context (Agent-Ready — reproduced in full)

### Problem Statement

Every sale initially enters the system with the status **Pending**. The system provides users an **Advance Payout** equal to **10% of the earnings** for all eligible pending sales. Later, an administrator **reconciles** each sale to one of:

- **Approved**
- **Rejected**

After reconciliation, the system calculates the user's **final payout**, accounting for any advance already transferred.

### Terminology

- **Pending** — the product has been purchased.
- **Approved** — the product has been successfully delivered and the return period has ended.
- **Rejected** — the purchased product was returned or cancelled.

### Business Rule 1 — Advance Payout

- Every **Pending** sale is eligible for an advance payout of **10% of its earnings**.
- Once an advance payout has been successfully transferred for a sale, **that sale must never receive another advance payout**, even if the advance payout job runs multiple times (idempotency requirement).

### Business Rule 2 — Final Payout Calculation

**Case 1 — Approved Sale.** Example: Pending sale, Earnings = ₹30, Advance paid = ₹3. On approval: remaining payout = ₹30 − ₹3 = **₹27**.

**Case 2 — Rejected Sale.** Example: Pending sale, Earnings = ₹50, Advance paid = ₹5. On rejection, the ₹5 already received was not entitled — it must be **adjusted against the final payout**: Adjustment = **−₹5**.

### Business Rule 3 — Withdrawal Restrictions

A user can make **only one payout withdrawal every 24 hours**.

### Question 2 — Failed Payout Recovery

A payout initiated to a user may later be **Cancelled**, **Rejected**, or **Failed**. In these cases the system must:

- Credit the failed payout amount back into the user's **withdrawable balance**.
- Allow the user to **initiate another withdrawal** for that amount.

### Reference Schema (sales table, as given — you may modify)

```json
[
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "pending",
		"earning": 40
	}
]
```

Brands given as examples: `brand_1`, `brand_2`, `brand_3`. Possible status values: `pending`, `approved`, `rejected`.

### Worked Example (from the assignment — use this to sanity-check your math exactly)

**Before Reconciliation** — three pending sales, same user/brand, ₹40 earning each:

```json
[
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "pending",
		"earning": 40
	},
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "pending",
		"earning": 40
	},
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "pending",
		"earning": 40
	}
]
```

Total Pending Earnings = ₹120. Advance Payout = 10% of ₹120 = **₹12** (i.e., ₹4 per sale).

**After Reconciliation:**

```json
[
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "rejected",
		"earning": 40
	},
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "approved",
		"earning": 40
	},
	{
		"userId": "john_doe",
		"brand": "brand_1",
		"status": "approved",
		"earning": 40
	}
]
```

| Sale     | Earnings | Advance Paid | Final Adjustment |
| -------- | -------- | ------------ | ---------------- |
| Rejected | ₹40      | ₹4           | −₹4              |
| Approved | ₹40      | ₹4           | ₹36              |
| Approved | ₹40      | ₹4           | ₹36              |

**Total Final Payout = −₹4 + ₹36 + ₹36 = ₹68**

⚠️ **This exact number (₹68) is your acceptance test.** Any implementation that doesn't reproduce this from this exact input is wrong.

### Expected Deliverables (verbatim from the assignment)

1. Low-Level Design (LLD).
2. Database schema(s) with relationships.
3. Class design (or equivalent design in your chosen language).
4. APIs/endpoints.
5. Handling of edge cases and failure scenarios.
6. Working implementation in JavaScript or Python.
7. Explanation of key design decisions and trade-offs.

### Submission Requirements (verbatim)

- Attach the source code in a **GitHub repo**. The repo link must be **public** and shared as the response to the assignment.
- Relevant **README files and docs** should be present **in the repo itself**.

### Design Freedom Granted (verbatim)

You are free to modify the reference schema, introduce additional tables/collections, design APIs, define entities/relationships/indexes/workflows, and explain trade-offs.

---

## 3. Design Spec — Chosen Solution (stated as decision, not options)

### Entities & Schema (Prisma — build exactly this in Phase 1)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id                          String    @id @default(uuid())
  username                    String    @unique
  withdrawableBalance         Decimal   @default(0) @db.Decimal(12, 2)
  lastSuccessfulWithdrawalAt  DateTime?
  createdAt                   DateTime  @default(now())

  sales   Sale[]
  payouts Payout[]
  ledger  LedgerEntry[]
}

model Brand {
  id    String @id @default(uuid())
  name  String @unique
  sales Sale[]
}

enum SaleStatus {
  PENDING
  APPROVED
  REJECTED
}

model Sale {
  id            String     @id @default(uuid())
  userId        String
  user          User       @relation(fields: [userId], references: [id])
  brandId       String
  brand         Brand      @relation(fields: [brandId], references: [id])
  earning       Decimal    @db.Decimal(12, 2)
  status        SaleStatus @default(PENDING)
  advancePaid   Decimal    @default(0) @db.Decimal(12, 2)
  advancePaidAt DateTime?
  reconciledAt  DateTime?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  payouts Payout[]
  ledger  LedgerEntry[]

  @@index([userId, status])
}

enum PayoutType {
  ADVANCE
  FINAL_ADJUSTMENT
  WITHDRAWAL
}

enum PayoutStatus {
  PENDING
  COMPLETED
  FAILED
  CANCELLED
  REJECTED
}

model Payout {
  id        String       @id @default(uuid())
  userId    String
  user      User         @relation(fields: [userId], references: [id])
  saleId    String?
  sale      Sale?        @relation(fields: [saleId], references: [id])
  type      PayoutType
  amount    Decimal      @db.Decimal(12, 2) // negative allowed for adjustments
  status    PayoutStatus @default(COMPLETED) // WITHDRAWAL starts PENDING
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  ledgerEntries LedgerEntry[]
}

enum LedgerReason {
  ADVANCE_PAYOUT
  FINAL_ADJUSTMENT
  WITHDRAWAL_RESERVED
  WITHDRAWAL_REVERSED
}

model LedgerEntry {
  id           String       @id @default(uuid())
  userId       String
  user         User         @relation(fields: [userId], references: [id])
  saleId       String?
  sale         Sale?        @relation(fields: [saleId], references: [id])
  payoutId     String?
  payout       Payout?      @relation(fields: [payoutId], references: [id])
  amount       Decimal      @db.Decimal(12, 2) // signed delta
  reason       LedgerReason
  balanceAfter Decimal      @db.Decimal(12, 2)
  createdAt    DateTime     @default(now())
}
```

**Why a ledger table in addition to a denormalized balance field:** `User.withdrawableBalance` gives O(1) reads for the hot path (checking balance before withdrawal). `LedgerEntry` is an immutable append-only audit trail — every balance mutation is traceable, and the balance is always recomputable/verifiable by summing ledger entries. This is the standard pattern for money-handling systems and is a strong thing to call out explicitly in the README trade-offs section.

### Module / Class Breakdown

- `services/advancePayoutService.js` — `runAdvancePayoutJob(userId?)`: finds `PENDING` sales with `advancePaidAt IS NULL`, computes 10%, writes `Payout(ADVANCE)` + `LedgerEntry(ADVANCE_PAYOUT)` + increments balance, all in one Prisma transaction per sale (row-locked via `SELECT ... FOR UPDATE` or Prisma's transaction isolation) to make concurrent job runs safe.
- `services/reconciliationService.js` — `reconcileSale(saleId, newStatus)`: guards that current status is `PENDING` (else 409), computes adjustment (`earning - advancePaid` if approved, `-advancePaid` if rejected), writes `Payout(FINAL_ADJUSTMENT)` + `LedgerEntry(FINAL_ADJUSTMENT)`, updates balance, sets `reconciledAt`.
- `services/withdrawalService.js` — `initiateWithdrawal(userId, amount)`: checks `now - lastSuccessfulWithdrawalAt < 24h` (skip check if null), checks `amount <= withdrawableBalance`, creates `Payout(WITHDRAWAL, PENDING)`, deducts balance immediately (reserved), writes `LedgerEntry(WITHDRAWAL_RESERVED)`. `resolveWithdrawal(payoutId, outcome)`: guards payout is currently `PENDING` (else 409, idempotency); if `COMPLETED`, sets `lastSuccessfulWithdrawalAt = now`; if `FAILED`/`CANCELLED`/`REJECTED`, credits balance back + `LedgerEntry(WITHDRAWAL_REVERSED)` and deliberately does **not** touch `lastSuccessfulWithdrawalAt` (so the 24h slot was never consumed).
- `services/ledgerService.js` — shared helper for writing ledger entries + balance updates atomically; every other service calls into this rather than mutating `User.withdrawableBalance` directly.
- `routes/*.js` — thin Express.js route handlers, no business logic, just request parsing + calling services + shaping responses.

### API Contracts

| Method | Path                                 | Body                                                               | Purpose                                                    |
| ------ | ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| POST   | `/api/sales`                         | `{ userId, brand, earning }`                                       | Create a pending sale (seeding/demo)                       |
| GET    | `/api/users/:username/sales?status=` | —                                                                  | List a user's sales                                        |
| POST   | `/api/jobs/advance-payout`           | `{ userId? }`                                                      | Run the advance payout job (all users, or scoped)          |
| POST   | `/api/admin/sales/:saleId/reconcile` | `{ status: "approved" \| "rejected" }`                             | Reconcile one sale                                         |
| GET    | `/api/users/:username/balance`       | —                                                                  | Current withdrawable balance                               |
| POST   | `/api/users/:username/withdraw`      | `{ amount }`                                                       | Initiate a withdrawal (24h-gated)                          |
| POST   | `/api/payouts/:payoutId/resolve`     | `{ status: "completed" \| "failed" \| "cancelled" \| "rejected" }` | Resolve a pending withdrawal (simulates processor webhook) |
| GET    | `/api/users/:username/ledger`        | —                                                                  | Full audit trail                                           |

### Edge Cases & How Each Is Handled

- **Advance job runs twice on the same sale** → no-op second time; guarded by `advancePaidAt IS NULL` check inside the transaction.
- **Reconciliation attempted twice on the same sale** → second attempt rejected with 409 (status must be `PENDING` to transition).
- **Sale rejected with no advance ever paid** → adjustment = 0, no-op, handled naturally by the formula (`-advancePaid` where `advancePaid = 0`).
- **Concurrent advance-job runs (race condition)** → prevented via DB transaction + row lock per sale.
- **Withdrawal requested with insufficient balance** → 400, no state change.
- **Withdrawal requested within 24h of last _successful_ withdrawal** → 429 with remaining-time info; failed/cancelled/rejected attempts do not count.
- **Double webhook resolving the same payout** → idempotent; second call rejected with 409 (payout must be `PENDING` to resolve).
- **Balance goes negative after a rejection following an already-withdrawn advance** → allowed (represents a debt); document as a trade-off — no automatic reversal from the user, next positive payout naturally offsets it. Block further withdrawals while balance ≤ 0.
- **Floating point precision on money** → use Prisma `Decimal` type throughout, never JS `number` for money math.

---

## 4. Time-Boxed Roadmap

**Day 1 — Saturday (assume ~10 effective hours)**

| Time       | Task                                                                                                              | Notes                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0:00–0:30  | Env setup: `bun init`, Prisma init, Postgres (or local SQLite for speed), repo init, `.env.example`, `.gitignore` |                                                |
| 0:30–2:00  | **Phase 1** — schema, migration, seed script matching reference data exactly                                      | Highest priority: get the ₹68 example seedable |
| 2:00–4:00  | **Phase 2** — core services (advance, reconciliation, ledger), pure/unit-testable                                 | Hardest logic — front-load it                  |
| 4:00–4:30  | Break                                                                                                             |                                                |
| 4:30–7:00  | **Phase 3** — Express.js routes wired to services                                                                 |                                                |
| 7:00–8:30  | **Phase 4** — concurrency guards, idempotency, edge cases                                                         |                                                |
| 8:30–10:00 | **Phase 5** — tests (money-math unit tests are non-negotiable; integration tests if time allows)                  |                                                |

_Checkpoint end of Day 1:_ core logic + APIs + at least the money-math unit tests must be green. If behind, cut integration tests first — never cut the unit tests that prove the ₹68 example.

**Day 2 — Sunday (until 6:00 PM, ~8–9 effective hours)**

| Time        | Task                                                                 | Notes                        |
| ----------- | -------------------------------------------------------------------- | ---------------------------- |
| 9:00–10:30  | Finish any Day 1 spillover                                           |                              |
| 10:30–12:30 | **Phase 6** — README + demo script/curl examples                     |                              |
| 12:30–13:30 | Break                                                                |                              |
| 13:30–15:00 | Manual end-to-end run against the exact worked example — confirm ₹68 | This is your acceptance test |
| 15:00–16:00 | Repo hygiene: clean commits, remove secrets, push, make public       |                              |
| 16:00–17:30 | Buffer for bugs/overrun                                              |                              |
| 17:30–18:00 | Final check, submit                                                  |                              |

**Must-have:** schema, idempotent advance payout, correct reconciliation math (verified against ₹68), 24h-gated withdrawal, failed-payout credit-back, seed script matching reference data, README, unit tests on the payout math.

**Nice-to-have (cut first if behind):** Postman collection (curl in README is enough), ledger pagination, Docker one-command run, CI config, admin auth.

**Checkpoint to reassess:** if the reconciliation math isn't producing exactly ₹68 on the worked example by 1:00 PM Sunday, stop everything else and fix that first — it's the single most heavily-weighted, most-checked piece of the whole assignment.

---

## 5. Phase-Wise Build Plan (Agent-Executable)

### Phase 1 — Data Models & Schema

- **Scope:** Prisma schema (as specified in §3), initial migration, seed script that recreates the exact worked example (3 sales, ₹40 each, one user `john_doe`, `brand_1`).
- **Files:** `prisma/schema.prisma`, `prisma/seed.js`, `.env.example`
- **Depends on:** nothing.
- **Definition of done:** `bunx prisma migrate dev` runs clean; seed script populates the exact reference data; `bunx prisma studio` shows correct rows.

### Phase 2 — Core Business Logic

- **Scope:** `advancePayoutService`, `reconciliationService`, `withdrawalService`, `ledgerService` as pure service functions, no HTTP layer yet. Write against an in-memory or test DB.
- **Files:** `src/services/*.js`
- **Depends on:** Phase 1.
- **Definition of done:** calling these services directly (e.g. from a script) against the seeded data reproduces ₹12 total advance and ₹68 total final payout exactly.

### Phase 3 — APIs / Endpoints

- **Scope:** Express.js app wiring all endpoints from §3's API contract table to the Phase 2 services.
- **Files:** `src/routes/*.js`, `src/index.js`
- **Depends on:** Phase 2.
- **Definition of done:** every endpoint in the contract table is reachable and returns correct shapes; manual curl walkthrough of the worked example via HTTP matches ₹68.

### Phase 4 — Edge Cases & Idempotency

- **Scope:** wrap all mutating operations in Prisma transactions with correct guards (as listed in §3 Edge Cases); add proper HTTP status codes for each failure mode.
- **Files:** modifications across `src/services/*.js`
- **Depends on:** Phase 3.
- **Definition of done:** double-running the advance job, double-reconciling a sale, and double-resolving a withdrawal are all safely no-ops/409s, verified manually or via test.

### Phase 5 — Tests

- **Scope:** unit tests for the money math (advance calc, approved/rejected adjustment, the exact ₹68 scenario) using `bun:test`; integration tests hitting the HTTP layer for the happy path and at least 2–3 edge cases.
- **Files:** `tests/*.test.js`
- **Depends on:** Phase 4.
- **Definition of done:** `bun test` green; the ₹68 worked example exists as a named test case.

### Phase 6 — README / Docs

- **Scope:** see §6 below.
- **Files:** `README.md`
- **Depends on:** Phase 5 (needs final endpoint list + run instructions to be accurate).
- **Definition of done:** a stranger can clone the repo, follow the README, and reproduce the ₹68 result with zero additional context.

---

## 6. Submission & Documentation Plan

**README outline:**

1. What this is (one paragraph, mirrors §1 Executive Summary)
2. Setup (`bun install`, `.env` setup, `bunx prisma migrate dev`, seed command)
3. How to run (`bun run src/index.js`)
4. How to demo "working" — either a `curl` walkthrough or a short script (`scripts/demo.js`) that seeds the exact worked example and prints the ₹68 result end-to-end
5. Design decisions & trade-offs (ledger + denormalized balance; Decimal for money; transaction-based idempotency; advance job as endpoint not cron; 24h lock tied to successful withdrawal not attempt)
6. Known limitations / what you'd add with more time (auth, rate limiting, real cron, Docker)

**Demonstrating "working":** a `scripts/demo.js` that runs the exact worked example end-to-end and prints `Final Payout = ₹68` is the single highest-value artifact for an evaluator — cheaper to build than a full Postman collection and directly proves correctness against the spec's own example.

**Repo cleanliness checklist:** no `.env` committed, `.env.example` present, meaningful commit messages (not "wip", "fix"), no commented-out dead code, repo set to public before submitting.

---

## 7. Risk & Fallback Plan

**Cut first if time runs short (in order):** Postman collection → ledger endpoint pagination → Docker setup → integration test breadth (keep only the money-math unit tests + the ₹68 demo script) → admin auth (note explicitly as an omitted trade-off, don't leave it unmentioned).

**Minimum viable submission that still satisfies the core ask:** Prisma schema + seed matching reference data, advance payout logic (idempotent), reconciliation logic verified against the exact ₹68 example, withdrawal with 24h restriction, failed-payout credit-back, a README explaining setup/run/design, and at least one automated test proving the payout math. This alone satisfies deliverables 1–7 even without any polish — it's a correct, demonstrable LLD implementation, which is what's actually being evaluated.

---
