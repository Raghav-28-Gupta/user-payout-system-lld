import { Prisma } from "../generated/prisma/client";

// Single money type for the whole codebase — never use JS `number` for money math.
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

import { AppError } from "./errors";

const ADVANCE_RATE = new Decimal("0.10");

/** Parses request-supplied money (number or numeric string) into a Decimal, or 400s. */
export function toDecimal(value: number | string, field: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new AppError(400, "INVALID_AMOUNT", `${field} must be a valid decimal number`);
  }
}

/** Advance payout for a sale: 10% of earnings, rounded half-up to 2 decimal places. */
export function advanceOn(earning: Decimal): Decimal {
  return earning.mul(ADVANCE_RATE).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
