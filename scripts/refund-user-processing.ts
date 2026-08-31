import { prisma } from '../src/lib/prisma';
import { refundStuckTransaction } from '../src/modules/transactions/transaction.service';
import { refundStuckBankTransfer } from '../src/modules/bank-transfer/bank-transfer.service';

const EMAIL = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!EMAIL) {
    console.error('Usage: tsx scripts/refund-user-processing.ts <email> [--dry-run]');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    console.error(`User not found: ${EMAIL}`);
    process.exit(1);
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id, status: 'PROCESSING' },
  });
  const bankTransfers = await prisma.bankTransfer.findMany({
    where: { userId: user.id, status: 'PROCESSING' },
  });

  console.log(`User: ${user.email} (${user.id})`);
  console.log(`PROCESSING transactions: ${transactions.length}`);
  for (const tx of transactions) {
    console.log(`  - ${tx.id} refId=${tx.refId} sellPrice=${tx.sellPrice}`);
  }
  console.log(`PROCESSING bank transfers: ${bankTransfers.length}`);
  for (const bt of bankTransfers) {
    console.log(`  - ${bt.id} amount=${(bt as any).amount ?? '(see schema)'}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run only, no refunds performed.');
    return;
  }

  for (const tx of transactions) {
    const result = await refundStuckTransaction(tx.id, 'manual-script:kirofyzu');
    console.log(`Refunded transaction ${tx.id} -> status ${result.status}`);
  }
  for (const bt of bankTransfers) {
    const result = await refundStuckBankTransfer(bt.id, 'manual-script:kirofyzu');
    console.log(`Refunded bank transfer ${bt.id} -> status ${result.status}`);
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
