// Guard for `npm run db:reset`, which ERASES every customer, case and payment.
if (process.env.I_KNOW_THIS_ERASES_EVERYTHING !== "yes") {
  console.error("\n  STOP: db:reset deletes ALL data (customers, cases, payments, files).");
  console.error("  Take a backup first (npm run backup). To really reset, run:");
  console.error("    I_KNOW_THIS_ERASES_EVERYTHING=yes npm run db:reset\n");
  process.exit(1);
}
