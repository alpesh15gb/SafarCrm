// Prints a Cookie header for a logged-in user (for smoke tests): node --env-file=.env.local scripts/cookie.mjs email password
import { createServerClient } from "@supabase/ssr";
const jar = new Map();
const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)) },
});
const { error } = await sb.auth.signInWithPassword({ email: process.argv[2], password: process.argv[3] ?? "Safar@2026" });
if (error) { console.error(error.message); process.exit(1); }
console.log([...jar].map(([n, v]) => `${n}=${v}`).join("; "));
