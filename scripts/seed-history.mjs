// Optional: adds ~5 months of past, completed demo trips so the dashboard trend chart has something to show.
// Run after `npm run seed`:  npm run seed:history
import { createClient } from "@supabase/supabase-js";

// Demo accounts use a published password: never create them anywhere but a local development database.
{
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!/^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) {
    console.error(`Refusing to load demo data into ${u.hostname}. Demo data is for local development only.`);
    process.exit(1);
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const db = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await db.auth.signInWithPassword({ email: "boss@safar.local", password: "Safar@2026" });
if (le) throw le;
const one = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

// demo only: never mix fake trips into a real agency's data
const { data: demoBoss } = await admin.auth.admin.listUsers();
if (!demoBoss.users.some((u) => u.email === "boss@safar.local")) { console.log("This is not the demo database. Nothing added."); process.exit(0); }
if ((await one(db.from("cases").select("id").eq("notes", "demo-history").limit(1))).length) {
  console.log("History already added."); process.exit(0);
}
const customers = await one(db.from("customers").select("id, full_name").neq("customer_type", "corporate"));
const suppliers = Object.fromEntries((await one(db.from("suppliers").select("id, services"))).flatMap((s) => s.services.map((x) => [x, s.id])));
const staff = (await one(db.from("profiles").select("id").in("role", ["boss", "staff"]))).map((p) => p.id);

const TRIPS = [
  ["Shimla and Manali", "Shimla"], ["Kashmir houseboat stay", "Srinagar"], ["Singapore family holiday", "Singapore"],
  ["Rajasthan heritage tour", "Jaipur"], ["Andaman beaches", "Port Blair"], ["Bali honeymoon", "Bali"],
  ["Ladakh road trip", "Leh"], ["Thailand group tour", "Bangkok"], ["Kerala Ayurveda retreat", "Kochi"],
  ["Char Dham yatra", "Haridwar"], ["Maldives getaway", "Male"], ["Darjeeling and Gangtok", "Gangtok"],
  ["Ooty and Coorg", "Ooty"], ["Vietnam explorer", "Hanoi"],
];
let r = 7;
const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
const now = new Date();

for (let i = 0; i < TRIPS.length; i++) {
  const monthsAgo = 5 - Math.floor(i / 3);
  if (monthsAgo < 1) break;
  const created = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 3 + Math.floor(rnd() * 22), 11);
  const start = new Date(created.getTime() + (10 + Math.floor(rnd() * 20)) * 86400e3);
  const end = new Date(start.getTime() + 5 * 86400e3);
  const iso = (d) => d.toISOString().slice(0, 10);
  const cust = customers[i % customers.length];
  const kase = await one(db.from("cases").insert({
    customer_id: cust.id, title: `${TRIPS[i][0]}, ${cust.full_name}`, destination: TRIPS[i][1], travel_start: iso(start), travel_end: iso(end),
    status: "completed", assigned_to: staff[i % staff.length], lead_source: ["Walk-in", "WhatsApp", "Referral", "Repeat"][i % 4], notes: "demo-history",
  }).select().single());
  const scale = 0.7 + rnd() * 1.6;
  const lines = [
    { service: "flight", supplier_cost: Math.round(24000 * scale), selling_price: Math.round(26800 * scale), details: { trip_type: "return", sectors: [] } },
    { service: "hotel", supplier_cost: Math.round(30000 * scale), selling_price: Math.round(35500 * scale), gst: Math.round(1700 * scale), details: { hotel_name: "Demo resort", city: TRIPS[i][1] } },
    ...(i % 2 ? [{ service: "insurance", supplier_cost: 900, selling_price: 1400, details: { insurer: "Tata AIG" } }] : []),
  ].map((l) => ({ ...l, case_id: kase.id, supplier_id: suppliers[l.service] ?? null, status: "confirmed", traveller_ids: [cust.id] }));
  await one(db.from("booking_lines").insert(lines, { defaultToNull: false }));
  const billed = lines.reduce((a, l) => a + l.selling_price + (l.gst ?? 0), 0);
  await one(db.from("payments").insert({ case_id: kase.id, direction: "in", amount: billed, mode: "upi", pay_date: iso(created), reference: `UPI-H${i}` }));
  await one(admin.from("cases").update({ created_at: created.toISOString() }).eq("id", kase.id));
  await admin.from("activity_log").delete().eq("entity_id", kase.id).is("actor", null);
}
console.log("Added past trips for the dashboard trend.");
