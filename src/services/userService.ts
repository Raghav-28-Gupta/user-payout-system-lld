import { prisma } from "../db";
import { AppError } from "../errors";
import type { LedgerEntry, User } from "../../generated/prisma/client";

export async function requireUser(username: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new AppError(404, "USER_NOT_FOUND", `no user named '${username}'`);
  return user;
}

export async function getBalance(username: string) {
  const user = await requireUser(username);
  return {
    username: user.username,
    withdrawableBalance: user.withdrawableBalance.toFixed(2),
    lastSuccessfulWithdrawalAt: user.lastSuccessfulWithdrawalAt,
  };
}

export async function getLedger(username: string): Promise<LedgerEntry[]> {
  const user = await requireUser(username);
  return prisma.ledgerEntry.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
}
