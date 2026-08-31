import { prisma } from '../src/lib/prisma';

const EMAIL = process.argv[2];

async function main() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const txs = await prisma.transaction.findMany({
    where: { userId: user.id, createdAt: { gte: hourAgo } },
    select: { id: true, refId: true, status: true, createdAt: true, sellPrice: true },
    orderBy: { createdAt: 'asc' },
  });

  const counted = txs.filter((t) => ['PENDING', 'PROCESSING', 'SUCCESS'].includes(t.status));

  console.log(`Total tx (1 jam terakhir): ${txs.length}`);
  console.log(`Counted toward hourly limit (PENDING/PROCESSING/SUCCESS): ${counted.length}`);
  for (const t of txs) {
    console.log(`  [${t.status}] ${t.refId} ${t.createdAt.toISOString()} Rp${t.sellPrice}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
