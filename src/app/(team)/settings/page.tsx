import { requireBoss } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Tabs } from "@/components/ui";
import { DataTab, GeneralTab, LookupsTab, PortalTab, RemindersTab, UsersTab } from "./client";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; kind?: string }> }) {
  const me = await requireBoss();
  const { tab = "general", kind = "airline" } = await searchParams;
  const sb = await createClient();
  const { data: s } = await sb.from("settings").select("*").eq("id", 1).single();
  const { data: next } = await sb.rpc("next_max_no");
  return (
    <>
      <PageHeader title="Settings" sub="Sensible defaults are already in place. Change only what you need." />
      <Tabs active={tab} base="/settings" tabs={[
        { key: "general", label: "Agency and MAX ID" }, { key: "users", label: "Users" }, { key: "portal", label: "Client portal" },
        { key: "reminders", label: "Automatic reminders" }, { key: "lookups", label: "Lookup lists" }, { key: "data", label: "Data" },
      ]} />
      {tab === "general" && <GeneralTab settings={s} nextMax={Number(next)} />}
      {tab === "users" && <UsersLoader meId={me.id} />}
      {tab === "portal" && <PortalTab settings={s} />}
      {tab === "reminders" && <RemindersTab settings={s} />}
      {tab === "lookups" && <LookupsLoader kind={kind} />}
      {tab === "data" && <DataLoader />}
    </>
  );
}

async function UsersLoader({ meId }: { meId: string }) {
  const sb = await createClient();
  const { data } = await sb.from("profiles").select("id, full_name, email, role, active, can_see_profit, can_see_all_cases, created_at").in("role", ["boss", "staff"]).order("role").order("full_name");
  const { data: counts } = await sb.from("cases").select("assigned_to").not("status", "in", "(completed,cancelled)");
  const open = new Map<string, number>();
  (counts ?? []).forEach((c) => c.assigned_to && open.set(c.assigned_to, (open.get(c.assigned_to) ?? 0) + 1));
  return <UsersTab meId={meId} users={(data ?? []).map((u) => ({ ...u, open_cases: open.get(u.id) ?? 0 }))} />;
}

async function LookupsLoader({ kind }: { kind: string }) {
  const sb = await createClient();
  const { data } = await sb.from("lookups").select("id, value, extra").eq("kind", kind).order("sort").order("value");
  return <LookupsTab kind={kind} items={data ?? []} />;
}

async function DataLoader() {
  const sb = await createClient();
  const { data } = await sb.from("backup_log").select("at, db_size, files_size").order("at", { ascending: false }).limit(5);
  // more than 36 hours since the last nightly backup means it has probably stopped
  const last = data?.[0]?.at;
  const stale = !last || Date.parse(last) < new Date().getTime() - 36 * 3600e3;
  return <DataTab backups={data ?? []} stale={stale} />;
}
