// Removes ALL demo data and turns the demo boss login into the real owner's login.
// Keeps: settings (agency name etc.), lists (airlines, airports, countries), reminders setup.
// Local database only (runs SQL inside the supabase_db_safarcrm Docker container).
//
//   npm run clean-start -- owner@agency.in "Owner Name" "a-strong-password" 1001
//
// Order matters: the database wipe runs first, in one transaction. If it fails, nothing at all has changed.
// Only after it succeeds are the stored files removed and the logins changed.
// DRY_RUN=1 runs the database step and then rolls it back (changes nothing), to check it would work.
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const [email, name, password, start = "1001"] = process.argv.slice(2);
const DRY = process.env.DRY_RUN === "1";
if (!email || !name || !password || password.length < 8 || !/^\d+$/.test(start)) {
  console.log('Usage: npm run clean-start -- owner@agency.in "Owner Name" "password-8+chars" [first MAX number, default 1001]');
  process.exit(1);
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const psql = (sql, capture = false) =>
  execFileSync("docker", ["exec", "-i", "supabase_db_safarcrm", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-tA"],
    { input: sql, stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"] })?.toString() ?? "";

const { data: list, error: le } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (le) throw le;
const boss = list.users.find((u) => u.app_metadata?.role === "boss");
if (!boss) throw new Error("No boss account found");
const lit = (s) => "$q$" + String(s).replace(/\$q\$/g, "") + "$q$";

// 1. wipe demo records and restart numbering (one transaction: all or nothing)
//    profiles.customer_id points at customers, so TRUNCATE ... CASCADE would also empty profiles (every login).
//    The link is detached for the wipe and put back afterwards.
const files = psql("select name from storage.objects where bucket_id = 'files';", true).split("\n").filter(Boolean);
psql(`
begin;
update public.profiles set customer_id = null;
alter table public.profiles drop constraint profiles_customer_fk;
truncate public.payment_allocations, public.payments, public.expenses, public.share_links, public.files,
         public.task_comments, public.tasks, public.notifications, public.booking_lines, public.case_travellers,
         public.cases, public.customer_documents, public.customers, public.families, public.suppliers, public.activity_log
         restart identity cascade;
alter table public.profiles add constraint profiles_customer_fk foreign key (customer_id) references public.customers (id) on delete set null;
update public.profiles set full_name = ${lit(name)}, active = true where id = '${boss.id}';
${DRY ? "-- (dry run: numbering left alone; setval is not undone by rollback)" : `select setval('public.max_seq', ${Number(start)}, false);
select setval('public.customer_code_seq', 1, false);`}
do $$ begin if (select count(*) from public.profiles where id = '${boss.id}') <> 1 then raise exception 'owner profile missing'; end if; end $$;
${DRY ? "rollback;" : "commit;"}
`);
if (DRY) {
  console.log(`Dry run OK: the database wipe would succeed (rolled back). ${files.length} stored file(s) and ${list.users.length - 1} other login(s) would be removed.`);
  process.exit(0);
}

// 2. uploaded files, through the Storage API (direct deletes are blocked, and would leave the files on disk)
for (let i = 0; i < files.length; i += 100) {
  const { error } = await admin.storage.from("files").remove(files.slice(i, i + 100));
  if (error) console.warn("Some files could not be removed:", error.message);
}

// 3. the demo boss becomes the real owner (same account, so nothing breaks); every other login is removed
const { error } = await admin.auth.admin.updateUserById(boss.id, { email, password, email_confirm: true, app_metadata: { ...boss.app_metadata, full_name: name } });
if (error) throw error;
for (const u of list.users) if (u.id !== boss.id) await admin.auth.admin.deleteUser(u.id);

console.log(`Clean start done. Log in as ${email}. The first case will be MAX-${start}.`);
