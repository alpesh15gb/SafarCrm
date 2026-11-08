// Create the first boss login on a fresh database:
//   node --env-file=.env.local scripts/create-boss.mjs boss@agency.in "Full Name" "a-strong-password"
import { createClient } from "@supabase/supabase-js";
const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password || password.length < 8) {
  console.error('Usage: node --env-file=.env.local scripts/create-boss.mjs email "Full Name" password(8+ chars)');
  process.exit(1);
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "boss", full_name: name } });
if (error) { console.error(error.message); process.exit(1); }
console.log(`Boss login created for ${email}. Log in at your CRM address.`);
