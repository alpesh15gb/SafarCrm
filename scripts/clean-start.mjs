// Removes ALL demo data and turns the demo boss login into the real owner's login.
// Keeps: settings (agency name etc.), lists (airlines, airports, countries), reminders setup.
// Local database only (runs SQL inside the supabase_db_safarcrm Docker container).
//
//   npm run clean-start -- owner@agency.in "Owner Name" "a-strong-password" 1001
//
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const [email, name, password, start = "1001"] = process.argv.slice(2);
if (!email || !name || !password || password.length < 8) {
  console.log('Usage: npm run clean-start -- owner@agency.in "Owner Name" "password-8+chars" [first MAX number, default 1001]');
  process.exit(1);
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_safarcrm", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql, stdio: ["pipe", "inherit", "inherit"] });

// 1. the demo boss becomes the real owner (same account, so nothing breaks)
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
const boss = list.users.find((u) => u.app_metadata?.role === "boss");
if (!boss) throw new Error("No boss account found");
const { error } = await admin.auth.admin.updateUserById(boss.id, { email, password, email_confirm: true, app_metadata: { ...boss.app_metadata, full_name: name } });
if (error) throw error;

// 2. remove every other login (demo staff and client portal logins)
for (const u of list.users) if (u.id !== boss.id) await admin.auth.admin.deleteUser(u.id);

// 3. wipe demo records and restart numbering
psql(`
begin;
update public.profiles set full_name = ${"$q$" + name + "$q$"}, active = true where id = '${boss.id}';
truncate public.payment_allocations, public.payments, public.expenses, public.share_links, public.files,
         public.task_comments, public.tasks, public.notifications, public.booking_lines, public.case_travellers,
         public.cases, public.customer_documents, public.customers, public.families, public.suppliers, public.activity_log
         restart identity cascade;
delete from storage.objects where bucket_id = 'files';
select setval('public.max_seq', ${Number(start)}, false);
select setval('public.customer_code_seq', 1, false);
commit;
`);
console.log(`Clean start done. Log in as ${email}. The first case will be MAX-${start}.`);
