/**
 * Seeds the exact worked example from the assignment:
 * user `john_doe`, brand `brand_1`, three PENDING sales of ₹40 each.
 * Wipes all existing rows first, so it can be re-run at any time.
 */
import { prisma } from "../src/db";

export async function resetAndSeed() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({ data: { username: "john_doe" } });
  const brand = await prisma.brand.create({ data: { name: "brand_1" } });
  await prisma.sale.createMany({
    data: Array.from({ length: 3 }, () => ({
      userId: user.id,
      brandId: brand.id,
      earning: 40,
    })),
  });
  return { user, brand };
}

if (import.meta.main) {
  resetAndSeed()
    .then(() => {
      console.log("Seeded: john_doe / brand_1 with 3 PENDING sales of ₹40 each");
    })
    .finally(() => prisma.$disconnect());
}
