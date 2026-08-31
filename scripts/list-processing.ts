import { prisma } from '../src/lib/prisma';

async function main() {
  const txs = await prisma.transaction.findMany({
    where: { status: 'PROCESSING' },
    select: {
      id: true,
      refId: true,
      createdAt: true,
      attemptCount: true,
      flaggedReason: true,
      sellPrice: true,
      user: { select: { email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(JSON.stringify(txs, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
