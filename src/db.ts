import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });

export const prisma = new PrismaClient({ adapter });

// The client type inside prisma.$transaction(async (tx) => ...) callbacks.
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Interactive transactions here are short (≤8 statements), but the database is
// hosted — allow for network latency instead of Prisma's tight 5s default.
export const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };
