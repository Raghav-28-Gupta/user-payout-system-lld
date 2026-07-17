import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });

export const prisma = new PrismaClient({ adapter });

// The client type inside prisma.$transaction(async (tx) => ...) callbacks.
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
