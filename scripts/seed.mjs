// Demo data for local development: node --env-file=.env.local scripts/seed.mjs
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

const PASSWORD = "Safar@2026";
const people = [
  { email: "boss@safar.local", full_name: "Rajesh Mehta", role: "boss" },
  { email: "priya@safar.local", full_name: "Priya Nair", role: "staff" },
  { email: "amit@safar.local", full_name: "Amit Verma", role: "staff" },
];

async function ensureUser(p) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list.users.find((u) => u.email === p.email);
  if (found) return found.id;
  const { data, error } = await admin.auth.admin.createUser({
    email: p.email, password: PASSWORD, email_confirm: true,
    app_metadata: { role: p.role, full_name: p.full_name },
  });
  if (error) throw error;
  return data.user.id;
}

const ids = {};
for (const p of people) ids[p.role === "boss" ? "boss" : p.email.split("@")[0]] = await ensureUser(p);

const db = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await db.auth.signInWithPassword({ email: "boss@safar.local", password: PASSWORD });
if (le) throw le;

const one = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

const existing = await one(db.from("customers").select("id").limit(1));
if (existing.length) { console.log("Demo data already present. Users: boss@safar.local / priya@safar.local / amit@safar.local, password", PASSWORD); process.exit(0); }

await one(db.from("settings").update({ agency_name: "Safar Travels", agency_phone: "+91 98200 11223", agency_email: "hello@safartravels.in", agency_address: "12 MG Road, Pune 411001" }).eq("id", 1));

const fam = await one(db.from("families").insert({ name: "Sharma family" }).select().single());
const [ramesh, sunita, aarav, neha, corp, kiran] = await one(db.from("customers").insert([
  { title: "Mr", first_name: "Ramesh", last_name: "Sharma", gender: "Male", dob: "1978-11-08", mobile: "+919876543210", whatsapp: "+919876543210", email: "ramesh.sharma@example.com", city: "Pune", state: "Maharashtra", family_id: fam.id, customer_type: "family", passport_surname: "SHARMA", passport_given_name: "RAMESH", passport_expiry: "2027-03-15", lead_source: "Walk-in", tags: ["Frequent"], assigned_to: ids.priya, meal_pref: "Veg", seat_pref: "Aisle", consent_docs: true, consent_date: "2026-01-10", whatsapp_optin: true },
  { title: "Mrs", first_name: "Sunita", last_name: "Sharma", gender: "Female", dob: "1981-04-22", mobile: "+919876543211", family_id: fam.id, customer_type: "family", anniversary: "2004-02-14", passport_expiry: "2031-08-01" },
  { title: "Mstr", first_name: "Aarav", last_name: "Sharma", gender: "Male", dob: "2014-07-30", mobile: "+919876543210", family_id: fam.id, customer_type: "family", meal_pref: "Child" },
  { title: "Ms", first_name: "Neha", last_name: "Kapoor", gender: "Female", dob: "1992-01-05", mobile: "+919812345678", email: "neha.k@example.com", city: "Mumbai", state: "Maharashtra", lead_source: "WhatsApp", tags: ["VIP"], assigned_to: ids.amit, visas: [{ country: "UAE", type: "Tourist", number: "UAE123", issue: "2026-01-01", expiry: "2027-01-01", entry: "Multiple" }] },
  { first_name: "Brightline Software Pvt Ltd", mobile: "+912026001234", email: "travel@brightline.in", customer_type: "corporate", company_name: "Brightline Software Pvt Ltd", gstin: "27AABCB1234F1Z5", city: "Pune", tags: ["Corporate"] },
  { title: "Mr", first_name: "Kiran", last_name: "Patil", mobile: "+919922334455", email: "kiran.patil@brightline.in", customer_type: "individual", designation: "Sales Manager", employee_id: "BL-0042", lead_source: "Repeat" },
], { defaultToNull: false }).select());
await one(db.from("customers").update({ company_id: corp.id, company_name: corp.company_name }).eq("id", kiran.id));
await one(db.rpc("set_customer_ids", { p_customer: ramesh.id, p_aadhaar: "234567891234", p_pan: "ABCPS1234K", p_passport: "Z1234567" }));

const [indigo, goaDmc, tata, railAgent, bus, tbo] = await one(db.from("suppliers").insert([
  { name: "Skyline Consolidators", supplier_type: "airline", services: ["flight"], terms: "credit", credit_days: 7, credit_limit: 500000, default_commission: 1, contact_person: "Vikram", mobile: "+919800000001" },
  { name: "Coastal Holidays DMC", supplier_type: "hotel", services: ["hotel"], terms: "credit", credit_days: 15, contact_person: "Fernandes", mobile: "+919800000002", city: "Goa" },
  { name: "Tata AIG", supplier_type: "insurance", services: ["insurance"], terms: "prepaid", default_commission: 15 },
  { name: "RailMitra Agency", supplier_type: "rail", services: ["rail"], terms: "prepaid" },
  { name: "Neeta Travels", supplier_type: "bus", services: ["bus"], terms: "prepaid", mobile: "+919800000005" },
  { name: "TBO Holidays", supplier_type: "portal", services: ["flight", "hotel"], terms: "credit", credit_days: 3, portal_url: "https://www.tboholidays.com", portal_login: "safar_pune" },
], { defaultToNull: false }).select());

const d = (offset) => { const t = new Date(); t.setDate(t.getDate() + offset); return t.toISOString().slice(0, 10); };

const [goa, dubai, corpTrip, enquiry] = await one(db.from("cases").insert([
  { customer_id: ramesh.id, title: "Pune to Goa, Sharma family", travel_start: d(2), travel_end: d(6), destination: "Goa", lead_source: "Walk-in", assigned_to: ids.priya, status: "booked" },
  { customer_id: neha.id, title: "Mumbai to Dubai, Neha Kapoor", travel_start: d(20), travel_end: d(26), destination: "Dubai", lead_source: "WhatsApp", assigned_to: ids.amit, status: "confirmed" },
  { customer_id: kiran.id, title: "Pune to Delhi, Kiran Patil (Brightline)", travel_start: d(9), travel_end: d(11), destination: "Delhi", lead_source: "Repeat", assigned_to: ids.boss, status: "quoted" },
  { customer_id: sunita.id, title: "Kerala backwaters, Sharma family", travel_start: d(60), destination: "Kerala", lead_source: "Phone", assigned_to: ids.priya, status: "enquiry" },
], { defaultToNull: false }).select());
await one(db.from("case_travellers").insert([sunita, aarav].map((c) => ({ case_id: goa.id, customer_id: c.id }))));

const fam3 = [ramesh.id, sunita.id, aarav.id];
const lines = await one(db.from("booking_lines").insert([
  { case_id: goa.id, service: "flight", supplier_id: indigo.id, status: "confirmed", traveller_ids: fam3, supplier_cost: 10000, selling_price: 11500, commission_type: "amount", commission_value: 200, gst: 0, payment_due_date: d(0),
    details: { trip_type: "return", cabin: "Economy", pnr: "6E7KQX", supplier_ref: "SKY-55821", baggage: "15 kg", refundable: false,
      sectors: [{ from: "PNQ", to: "GOI", date: d(2), airline: "IndiGo", flight_no: "6E 6311", dep: "07:10", arr: "08:15" }, { from: "GOI", to: "PNQ", date: d(6), airline: "IndiGo", flight_no: "6E 6312", dep: "19:00", arr: "20:05" }],
      tickets: [{ passenger: "Ramesh Sharma", number: "312-4455667788" }, { passenger: "Sunita Sharma", number: "312-4455667789" }, { passenger: "Aarav Sharma", number: "312-4455667790" }] } },
  { case_id: goa.id, service: "hotel", supplier_id: goaDmc.id, status: "confirmed", traveller_ids: fam3, supplier_cost: 24000, selling_price: 27500, gst: 1375,
    details: { hotel_name: "Taj Holiday Village", city: "Goa", check_in: d(2), check_out: d(6), rooms: 1, room_type: "Deluxe sea view", meal_plan: "CP", adults: 2, children: 1, confirmation_no: "THV-99812", free_cancel_until: d(1) } },
  { case_id: dubai.id, service: "flight", supplier_id: tbo.id, status: "confirmed", traveller_ids: [neha.id], supplier_cost: 28000, selling_price: 31000, commission_type: "percent", commission_value: 1, payment_due_date: d(5),
    details: { trip_type: "return", cabin: "Economy", pnr: "EK9QWE", sectors: [{ from: "BOM", to: "DXB", date: d(20), airline: "Emirates", flight_no: "EK 501", dep: "04:30", arr: "06:05" }, { from: "DXB", to: "BOM", date: d(26), airline: "Emirates", flight_no: "EK 500", dep: "21:45", arr: "02:10" }] } },
  { case_id: dubai.id, service: "hotel", supplier_id: tbo.id, status: "pending", traveller_ids: [neha.id], supplier_cost: 36000, selling_price: 40000, gst: 2000,
    details: { hotel_name: "Rove Downtown", city: "Dubai", check_in: d(20), check_out: d(26), rooms: 1, room_type: "Rover room", meal_plan: "CP", adults: 1, children: 0, free_cancel_until: d(15) } },
  { case_id: corpTrip.id, service: "rail", supplier_id: railAgent.id, status: "pending", traveller_ids: [kiran.id], supplier_cost: 3200, selling_price: 3600,
    details: { train_no: "12493", train_name: "Darshan Express", from: "PUNE", to: "NZM", date: d(9), class: "2A", quota: "Tatkal", pnr: "4521336789", rail_status: "WL 12" } },
  { case_id: corpTrip.id, service: "bus", supplier_id: bus.id, status: "pending", traveller_ids: [kiran.id], supplier_cost: 1100, selling_price: 1300,
    details: { operator: "Neeta Travels", from: "Delhi", to: "Jaipur", date: d(11), boarding_point: "Kashmere Gate", boarding_time: "22:30", drop_point: "Sindhi Camp", bus_type: "AC sleeper", seats: "L4", ticket_no: "NT-77881" } },
], { defaultToNull: false }).select());

await one(db.from("expenses").insert({ case_id: goa.id, name: "Card charges", amount: 300 }));
await one(db.from("payments").insert([
  { direction: "in", case_id: goa.id, amount: 25000, mode: "upi", reference: "UPI-338812", received_by: ids.priya, pay_date: d(-10) },
  { direction: "in", case_id: dubai.id, amount: 20000, mode: "bank", reference: "NEFT-99102", received_by: ids.amit, pay_date: d(-3) },
], { defaultToNull: false }));
const sp = await one(db.from("payments").insert({ direction: "out", supplier_id: indigo.id, amount: 10000, mode: "bank", reference: "NEFT-5512", pay_date: d(-5) }).select().single());
await one(db.from("payment_allocations").insert({ payment_id: sp.id, case_id: goa.id, amount: 10000 }));

const due = (h) => new Date(Date.now() + h * 3600e3).toISOString();
await one(db.from("tasks").insert([
  { case_id: goa.id, title: "Send hotel voucher on WhatsApp", assigned_to: ids.priya, due_at: due(-5), priority: "high", alert: "15m" },
  { case_id: dubai.id, title: "Collect balance payment from Neha", assigned_to: ids.amit, due_at: due(3), priority: "normal", alert: "1h" },
  { case_id: dubai.id, title: "Apply for UAE visa", assigned_to: ids.amit, due_at: due(48), priority: "high", alert: "1d" },
  { case_id: corpTrip.id, title: "Share quote with Brightline travel desk", assigned_to: ids.boss, due_at: due(2), alert: "due" },
], { defaultToNull: false }));

console.log("Seeded. Log in with boss@safar.local, priya@safar.local or amit@safar.local, password", PASSWORD, "| lines:", lines.length);
