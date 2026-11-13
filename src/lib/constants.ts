export const SERVICES = ["flight", "hotel", "visa", "insurance", "rail", "bus", "other"] as const;
export type Service = (typeof SERVICES)[number];
export const SERVICE_LABEL: Record<Service, string> = {
  flight: "Flight", hotel: "Hotel", visa: "Visa", insurance: "Insurance", rail: "Rail", bus: "Bus", other: "Other",
};

export const CASE_STATUSES = ["enquiry", "quoted", "confirmed", "booked", "completed", "cancelled"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const STATUS_LABEL: Record<string, string> = {
  enquiry: "Enquiry", quoted: "Quoted", confirmed: "Confirmed", booked: "Booked", completed: "Completed", cancelled: "Cancelled",
  pending: "Pending", todo: "To do", in_progress: "In progress", done: "Done", active: "Active", inactive: "Inactive",
  ok: "Reviewed", pending_review: "Pending review",
  // ticket imports and the case work summary
  received: "Queued", processing: "Reading", needs_review: "Needs review", failed: "Needs manual entry", duplicate: "Duplicate", rejected: "Rejected",
  new: "New", waiting_customer: "Waiting on customer", waiting_supplier: "Waiting on supplier", up_to_date: "On track", no_next_step: "No next step", overdue: "Overdue", closed: "Closed",
};
export const STATUS_TONE: Record<string, Tone> = {
  enquiry: "grey", quoted: "blue", confirmed: "amber", booked: "green", completed: "green", cancelled: "red",
  pending: "grey", todo: "grey", in_progress: "blue", done: "green", active: "green", inactive: "grey",
  ok: "green", pending_review: "amber",
  received: "grey", processing: "blue", needs_review: "amber", failed: "red", duplicate: "grey", rejected: "grey",
  new: "grey", waiting_customer: "amber", waiting_supplier: "amber", up_to_date: "green", no_next_step: "red", overdue: "red", closed: "grey",
};
export type Tone = "grey" | "blue" | "amber" | "green" | "red" | "coral";

export const LEAD_SOURCES = ["Walk-in", "Phone", "WhatsApp", "Referral", "Website", "Repeat", "Other"];
export const PAY_MODES = [
  { value: "cash", label: "Cash" }, { value: "upi", label: "UPI" }, { value: "bank", label: "Bank transfer" },
  { value: "card", label: "Card" }, { value: "cheque", label: "Cheque" },
];
export const PAY_MODE_LABEL = Object.fromEntries(PAY_MODES.map((m) => [m.value, m.label]));

export const PRIORITIES = [{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }];
export const ALERTS = [
  { value: "none", label: "No alert" }, { value: "due", label: "At due time" }, { value: "15m", label: "15 minutes before" },
  { value: "1h", label: "1 hour before" }, { value: "1d", label: "1 day before" },
];

export const SUPPLIER_TYPES = [
  { value: "airline", label: "Airline or consolidator" }, { value: "hotel", label: "Hotel or DMC" },
  { value: "visa", label: "Visa agent or VFS/BLS" }, { value: "insurance", label: "Insurance" }, { value: "rail", label: "Rail agent" }, { value: "bus", label: "Bus operator" },
  { value: "portal", label: "Booking portal or GDS" }, { value: "other", label: "Other" },
];
export const SUPPLIER_TYPE_LABEL = Object.fromEntries(SUPPLIER_TYPES.map((m) => [m.value, m.label]));
// prepaid = paid on the booking date; wallet = topped up ahead, bookings draw from it on their own
export const SUPPLIER_TERMS = [
  { value: "prepaid", label: "Pay on booking" }, { value: "wallet", label: "Prepaid wallet" }, { value: "credit", label: "Credit" },
];
export function supplierTermsText(s: { terms: string; credit_days?: number | null }) {
  if (s.terms === "credit") return `Credit ${s.credit_days ?? 0} days`;
  return s.terms === "wallet" ? "Prepaid wallet" : "Pay on booking";
}

export const FILE_KINDS = [
  { value: "ticket", label: "Ticket" }, { value: "voucher", label: "Voucher" }, { value: "policy", label: "Policy" }, { value: "visa", label: "Visa" },
  { value: "document", label: "Document" }, { value: "other", label: "Other" },
];
export const DEFAULT_KIND: Record<Service, string> = {
  flight: "ticket", rail: "ticket", bus: "ticket", hotel: "voucher", insurance: "policy", visa: "visa", other: "other",
};

// ---------------------------------------------------------------- service detail fields
export type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "date" | "time" | "number" | "select" | "bool" | "textarea";
  options?: string[];
  list?: string; // datalist / lookup kind
  half?: boolean;
  required?: boolean;
  hint?: string;
};

export const VISA_TYPES = ["Tourist", "Business", "Visit (family)", "Transit", "Student", "Work", "Medical", "Conference"];
export const VISA_MODES = ["Online (e-Visa)", "Appointment at VFS / embassy", "On arrival"];

const BASE_DOCS = [
  "Original passport with 2 blank pages (check how long it must stay valid for this country; we advise 6 months after return)",
  "Passport-size photo, white background",
  "Return flight reservation (a confirmed itinerary; buy the ticket only if the embassy asks for one)",
  "Hotel booking for the whole stay",
];
const MONEY_DOCS = ["Bank statement, last 6 months (bank stamped)", "Income tax returns (ITR), last 2–3 years", "Salary slips or business proof", "Leave letter or NOC from employer", "Cover letter with day-by-day plan"];
const STRICT = ["Schengen (Europe)", "United Kingdom", "United States", "Canada", "Australia", "New Zealand", "Japan", "South Korea", "China"];
const NEEDS_APPOINTMENT = ["Schengen (Europe)", "United Kingdom", "United States", "Canada"];

/** Sensible starting point when a country is picked. Staff can add or remove items on the card. */
export function visaTemplate(country: string): { mode: string; checklist: string[] } {
  const c = country.trim();
  const strict = STRICT.some((x) => x.toLowerCase() === c.toLowerCase());
  const appt = NEEDS_APPOINTMENT.some((x) => x.toLowerCase() === c.toLowerCase());
  const extra = c.startsWith("Schengen") ? ["Travel insurance with €30,000 medical cover (amount shown in euros)", "Passport valid 3 months after leaving the Schengen area and issued in the last 10 years (official rule)"]
    : c === "United States" ? ["DS-160 confirmation page", "Interview appointment letter"] : [];
  return {
    mode: appt ? VISA_MODES[1] : VISA_MODES[0],
    checklist: [...BASE_DOCS, ...(strict ? MONEY_DOCS : ["Bank statement, last 3 months"]), ...extra],
  };
}

export const VISA_STATUSES = ["Documents pending", "Documents received", "Applied", "Appointment booked", "Biometrics done", "Under process", "Approved", "Rejected", "Passport collected"];
export const VISA_STATUS_TONE: Record<string, Tone> = {
  "Documents pending": "amber", "Documents received": "grey", Applied: "blue", "Appointment booked": "blue", "Biometrics done": "blue",
  "Under process": "blue", Approved: "green", Rejected: "red", "Passport collected": "green",
};

export const SERVICE_FIELDS: Record<Service, { main: FieldDef[]; more: FieldDef[] }> = {
  flight: {
    main: [
      { key: "trip_type", label: "Trip type", type: "select", options: ["one-way", "return", "multi-city"] },
      { key: "pnr", label: "Airline PNR" },
      { key: "cabin", label: "Cabin class", type: "select", options: ["Economy", "Premium economy", "Business", "First"] },
    ],
    more: [
      { key: "supplier_ref", label: "Supplier or GDS reference", hint: "Never shown to the client" },
      { key: "base_fare", label: "Base fare (₹)", type: "number", hint: "From the fare breakdown, before taxes. Commission % is worked out on this" },
      { key: "baggage", label: "Baggage" },
      { key: "refundable", label: "Refundable", type: "bool" },
    ],
  },
  hotel: {
    main: [
      { key: "hotel_name", label: "Hotel name", required: true, list: "hotel_chain" },
      { key: "city", label: "City", list: "city" },
      { key: "check_in", label: "Check-in", type: "date", half: true },
      { key: "check_out", label: "Check-out", type: "date", half: true },
      { key: "confirmation_no", label: "Confirmation no." },
    ],
    more: [
      { key: "rooms", label: "Rooms", type: "number", half: true },
      { key: "room_type", label: "Room type", half: true },
      { key: "meal_plan", label: "Meal plan", type: "select", options: ["EP", "CP", "MAP", "AP"], half: true },
      { key: "adults", label: "Adults", type: "number", half: true },
      { key: "children", label: "Children", type: "number", half: true },
      { key: "free_cancel_until", label: "Free cancellation until", type: "date", half: true },
    ],
  },
  visa: {
    main: [
      { key: "country", label: "Country", required: true, list: "country", hint: "Pick from the list to fill the checklist for you" },
      { key: "visa_type", label: "Visa type", type: "select", options: VISA_TYPES, half: true },
      { key: "mode", label: "How it is applied", type: "select", options: VISA_MODES, half: true },
    ],
    more: [
      { key: "application_no", label: "Application / reference no.", half: true },
      { key: "entry", label: "Entry", type: "select", options: ["Single", "Double", "Multiple"], half: true },
      { key: "appointment_date", label: "Appointment date", type: "date", half: true },
      { key: "appointment_time", label: "Appointment time", type: "time", half: true },
      { key: "appointment_center", label: "Appointment centre", hint: "For example VFS Global, Andheri, Mumbai" },
      { key: "applied_on", label: "Applied on", type: "date", half: true },
      { key: "expected_by", label: "Decision expected by", type: "date", half: true },
      { key: "visa_number", label: "Visa number", half: true },
      { key: "stay_days", label: "Stay allowed (days)", type: "number", half: true },
      { key: "valid_from", label: "Valid from", type: "date", half: true },
      { key: "valid_to", label: "Valid until", type: "date", half: true },
      { key: "application_status", label: "Status (to correct a mistake)", type: "select", options: VISA_STATUSES },
    ],
  },
  insurance: {
    main: [
      { key: "insurer", label: "Insurer", list: "insurer", required: true },
      { key: "plan", label: "Plan" },
      { key: "policy_no", label: "Policy no." },
      { key: "start_date", label: "Start date", type: "date", half: true },
      { key: "end_date", label: "End date", type: "date", half: true },
    ],
    more: [
      { key: "sum_insured", label: "Sum insured", half: true },
      { key: "region", label: "Region", type: "select", options: ["Asia", "Schengen", "Worldwide excl. USA", "Worldwide"], half: true },
    ],
  },
  rail: {
    main: [
      { key: "train_no", label: "Train no.", half: true, required: true },
      { key: "train_name", label: "Train name", half: true },
      { key: "from", label: "From", half: true },
      { key: "to", label: "To", half: true },
      { key: "date", label: "Date", type: "date", half: true },
      { key: "class", label: "Class", type: "select", options: ["SL", "3E", "3A", "2A", "1A", "CC", "EC"], half: true },
      { key: "pnr", label: "PNR", half: true },
      { key: "rail_status", label: "Status", hint: "CNF, RAC 4, WL 12", half: true },
    ],
    more: [
      { key: "quota", label: "Quota", type: "select", options: ["General", "Tatkal", "Premium Tatkal", "Senior citizen"], half: true },
      { key: "coach", label: "Coach", half: true },
      { key: "berth", label: "Berth", half: true },
    ],
  },
  bus: {
    main: [
      { key: "operator", label: "Operator", required: true },
      { key: "from", label: "From", half: true },
      { key: "to", label: "To", half: true },
      { key: "date", label: "Date", type: "date", half: true },
      { key: "boarding_time", label: "Boarding time", type: "time", half: true },
      { key: "ticket_no", label: "Ticket no.", half: true },
      { key: "seats", label: "Seat numbers", half: true },
    ],
    more: [
      { key: "boarding_point", label: "Boarding point" },
      { key: "drop_point", label: "Drop point" },
      { key: "bus_type", label: "Bus type", type: "select", options: ["AC sleeper", "AC seater", "Non-AC sleeper", "Non-AC seater", "AC semi-sleeper"] },
    ],
  },
  other: {
    main: [
      { key: "title", label: "Title", hint: "Cab, forex, sightseeing, passport service", required: true },
      { key: "date", label: "Date", type: "date" },
      { key: "description", label: "Description", type: "textarea" },
    ],
    more: [],
  },
};

// Read-only labels for showing details (portal and booking cards)
export const DETAIL_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(SERVICE_FIELDS).flatMap((s) => [...s.main, ...s.more].map((f) => [f.key, f.label])),
);

/** How a family member is related to the family. The value implies a gender where obvious. */
export const RELATIONS = ["Head of family", "Wife", "Husband", "Son", "Daughter", "Father", "Mother", "Brother", "Sister", "Grandfather", "Grandmother", "Grandson", "Granddaughter", "Daughter-in-law", "Son-in-law", "Other"];
export const RELATION_GENDER: Record<string, "Male" | "Female"> = {
  Wife: "Female", Husband: "Male", Son: "Male", Daughter: "Female", Father: "Male", Mother: "Female", Brother: "Male", Sister: "Female",
  Grandfather: "Male", Grandmother: "Female", Grandson: "Male", Granddaughter: "Female", "Daughter-in-law": "Female", "Son-in-law": "Male",
};
