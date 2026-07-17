import { prisma } from "../db";
import { AppError } from "../errors";
import type { Decimal } from "../money";
import { requireUser } from "./userService";
import type { Sale, SaleStatus } from "../../generated/prisma/client";

/**
 * Records a pending sale. The reference schema identifies users/brands by
 * name (`"userId": "john_doe"`, `"brand": "brand_1"`), so both are upserted
 * on first sight — mirrors how affiliate events arrive from a tracker.
 */
export async function createSale(args: {
  userId: string;
  brand: string;
  earning: Decimal;
}): Promise<Sale> {
  if (args.earning.lte(0)) {
    throw new AppError(400, "INVALID_EARNING", "earning must be a positive amount");
  }

  const user = await prisma.user.upsert({
    where: { username: args.userId },
    update: {},
    create: { username: args.userId },
  });
  const brand = await prisma.brand.upsert({
    where: { name: args.brand },
    update: {},
    create: { name: args.brand },
  });

  return prisma.sale.create({
    data: { userId: user.id, brandId: brand.id, earning: args.earning },
  });
}

export async function listSales(username: string, status?: SaleStatus): Promise<Sale[]> {
  const user = await requireUser(username);

  return prisma.sale.findMany({
    where: { userId: user.id, ...(status && { status }) },
    orderBy: { createdAt: "asc" },
  });
}
