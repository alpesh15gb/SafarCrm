import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, btnClass } from "@/components/ui";
import { MoneyAccountsTab, type AccountRow } from "../settings/client";

export const metadata = { title: "Accounts" };

/** Money accounts in the left menu (owner, 2026-11-18): each bank account, credit card, cash and UPI with its
 *  balance, a passbook per account, and the boss sets them up here. Boss and staff who may see profit. */
export default async function AccountsPage() {
  const me = await requireTeam();
  if (me.role !== "boss" && !me.can_see_profit) redirect("/dashboard");
  const sb = await createClient();
  const { data } = await sb.rpc("money_account_balances");
  return (
    <>
      <PageHeader title="Accounts" sub="Bank accounts, credit cards, cash and UPI: what is in each, and every payment through it."
        action={<Link href="/reports?r=cashbook" className={btnClass("secondary")}><BookOpen className="h-4 w-4" />Cash and bank book</Link>} />
      <MoneyAccountsTab accounts={(data ?? []) as AccountRow[]} canEdit={me.role === "boss"} />
    </>
  );
}
