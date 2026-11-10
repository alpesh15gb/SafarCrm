import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Avatar, Badge, Card, PageHeader, StatusBadge, Table, Tabs, btnClass } from "@/components/ui";
import { CopyButton } from "@/components/client";
import { NewButton } from "@/components/list-tools";
import { ActivityList } from "@/components/activity";
import { expiryLabel, fdate, prettyPhone, waLink } from "@/lib/format";
import { CustomerForm } from "./form";
import { CustomerActions, DocumentsTab } from "./tabs";
import { FamilyTab, type FamilyMember } from "./family";

const COLS = "id, code, customer_type, family_id, relation, company_id, title, first_name, middle_name, last_name, full_name, gender, dob, nationality, marital_status, anniversary, mobile, alt_mobile, whatsapp, email, address1, address2, city, state, pin, country, language, voter_id, dl_number, dl_expiry, passport_surname, passport_given_name, passport_issue, passport_expiry, passport_place, passport_country, passport_ecr, passport_file_no, visas, other_ids, loyalty, irctc_id, senior_citizen, berth_pref, bus_pref, seat_pref, meal_pref, special_assistance, preferred_airlines, hotel_star, room_pref, travel_notes, emergency_name, emergency_relation, emergency_mobile, company_name, gstin, billing_address, designation, employee_id, lead_source, referred_by, assigned_to, tags, notes, consent_docs, consent_date, whatsapp_optin, created_at";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.from("customers").select("full_name").eq("id", id).maybeSingle();
  return { title: data?.full_name ?? "Customer" };
}

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const me = await requireTeam();
  const { id } = await params;
  const { tab = "profile" } = await searchParams;
  const sb = await createClient();
  const { data: c } = await sb.from("customers").select(COLS).eq("id", id).maybeSingle();
  if (!c) notFound();

  const [{ data: ids }, { count: pending }, { data: portal }, { data: photo }] = await Promise.all([
    sb.rpc("get_customer_ids", { p_customer: id }),
    sb.from("customer_documents").select("id", { count: "exact", head: true }).eq("customer_id", id).eq("status", "pending_review"),
    sb.from("profiles").select("id, active").eq("customer_id", id).eq("role", "client").maybeSingle(),
    sb.from("customer_documents").select("id").eq("customer_id", id).eq("doc_type", "Photo").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const exp = expiryLabel(c.passport_expiry);

  return (
    <>
      <PageHeader
        back={{ href: "/customers", label: "Customers" }}
        title={
          <span className="flex items-center gap-3">
            {photo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={`/api/docs/${photo.id}`} alt="" className="h-14 w-14 rounded-full object-cover ring-4 ring-white shadow-soft" />
              : <Avatar name={c.full_name} size="xl" className="!ring-4 shadow-soft" />}
            {c.title ? `${c.title} ` : ""}{c.full_name}
          </span>
        }
        sub={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono">{c.code}</span> · {prettyPhone(c.mobile)}<CopyButton text={c.mobile} />
            {c.email && <>· {c.email}</>}
            {c.customer_type === "corporate" ? <Badge tone="blue">Corporate</Badge> : c.family_id && <Badge tone="blue">{c.relation ? `Family · ${c.relation}` : "Family"}</Badge>}
            {(c.tags as string[]).map((t) => <Badge key={t} tone={t === "VIP" ? "coral" : "grey"}>{t}</Badge>)}
            {exp && exp.tone !== "grey" && <Badge tone={exp.tone}>Passport: {exp.text.toLowerCase()}</Badge>}
            {portal && <Badge tone={portal.active ? "green" : "grey"}>{portal.active ? "Portal login" : "Portal off"}</Badge>}
          </span>
        }
        action={
          <>
            <a className={btnClass("secondary")} href={waLink(c.whatsapp || c.mobile, `Namaste ${c.first_name}, `)} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />WhatsApp</a>
            <CustomerActions customer={{ id: c.id, full_name: c.full_name }} isBoss={me.role === "boss"} hasPortal={!!portal?.active} />
            <NewButton kind="case" label="New case" preset={{ customer: { id: c.id, label: c.full_name } }} />
          </>
        }
      />
      <Tabs active={tab} base={`/customers/${id}`} tabs={[
        { key: "profile", label: "Profile" },
        { key: "documents", label: pending ? `Documents (${pending} to review)` : "Documents" },
        { key: "family", label: c.customer_type === "corporate" ? "Employees" : "Family" },
        { key: "cases", label: "Cases" },
        { key: "activity", label: "Activity" },
      ]} />
      {tab === "profile" && <div className="max-w-4xl"><CustomerForm customer={c} ids={(ids?.[0] ?? { aadhaar_masked: null, pan: null, passport: null })} /></div>}
      {tab === "documents" && <DocumentsLoader id={id} />}
      {tab === "family" && <FamilyLoader head={{ id: c.id, first_name: c.first_name, last_name: c.last_name, mobile: c.mobile }} familyId={c.family_id} companyId={c.company_id} type={c.customer_type} />}
      {tab === "cases" && <CasesLoader id={id} />}
      {tab === "activity" && <ActivityLoader id={id} />}
    </>
  );
}

async function DocumentsLoader({ id }: { id: string }) {
  const sb = await createClient();
  const [{ data: docs }, { data: nums }, { data: types }] = await Promise.all([
    sb.from("customer_documents").select("id, doc_type, expiry, note, file_name, mime, status, created_at, storage_path, uploader:profiles!customer_documents_uploaded_by_fkey(full_name, role)").eq("customer_id", id).order("created_at", { ascending: false }),
    sb.rpc("document_numbers", { p_customer: id }),
    sb.from("lookups").select("value").eq("kind", "document_type").eq("active", true).order("sort"),
  ]);
  const n = new Map<string, string | null>((nums ?? []).map((x: { id: string; number: string | null }) => [x.id, x.number]));
  return <DocumentsTab customerId={id} types={(types ?? []).map((t) => t.value)}
    docs={(docs ?? []).map((d) => ({ ...d, has_file: !!d.storage_path, number: n.get(d.id) ?? null, uploader: d.uploader as unknown as { full_name: string; role: string } | null }))} />;
}

const PEOPLE = "id, code, full_name, relation, designation, gender, dob, mobile, passport_expiry, meal_pref, passport_hash, aadhaar_last4";
type PeopleRow = Omit<FamilyMember, "has_passport_no" | "has_aadhaar" | "docs"> & { passport_hash: string | null; aadhaar_last4: string | null };

/** Family members or employees, with what is on file for each (hashes never leave the server). */
async function people(sb: Awaited<ReturnType<typeof createClient>>, col: "family_id" | "company_id", val: string | null): Promise<FamilyMember[]> {
  if (!val) return [];
  const { data } = await sb.from("customers").select(PEOPLE).eq(col, val).order(col === "family_id" ? "dob" : "full_name", { nullsFirst: false });
  const list = (data ?? []) as PeopleRow[];
  const { data: docs } = list.length ? await sb.from("customer_documents").select("customer_id, doc_type").in("customer_id", list.map((m) => m.id)) : { data: [] };
  const by = new Map<string, Set<string>>();
  for (const d of docs ?? []) by.set(d.customer_id, (by.get(d.customer_id) ?? new Set()).add(d.doc_type));
  return list.map(({ passport_hash, aadhaar_last4, ...m }) => ({ ...m, has_passport_no: !!passport_hash, has_aadhaar: !!aadhaar_last4, docs: [...(by.get(m.id) ?? [])] }));
}

async function FamilyLoader({ head, familyId, companyId, type }: { head: { id: string; first_name: string; last_name: string | null; mobile: string }; familyId: string | null; companyId: string | null; type: string }) {
  const sb = await createClient();
  const id = head.id;
  const corporate = type === "corporate";
  const [{ data: fam }, members, employees, { data: company }] = await Promise.all([
    familyId ? sb.from("families").select("id, name").eq("id", familyId).single() : Promise.resolve({ data: null }),
    people(sb, "family_id", familyId),
    people(sb, "company_id", corporate ? id : null),
    companyId ? sb.from("customers").select("id, full_name").eq("id", companyId).single() : Promise.resolve({ data: null }),
  ]);
  // head of family first, then this customer, then the rest by age (oldest first)
  members.sort((a, b) => Number(b.relation === "Head of family") - Number(a.relation === "Head of family") || Number(b.id === id) - Number(a.id === id));
  return <FamilyTab head={head} family={fam} members={members} employees={employees} company={company} isCorporate={corporate} />;
}

async function CasesLoader({ id }: { id: string }) {
  const sb = await createClient();
  // every case where this person pays, travels, or both (one row per case), limited to the cases the viewer may open
  const { data: hist, error } = await sb.rpc("customer_case_history", { p_customer: id });
  const data = (hist ?? []) as { id: string; max_id: string; title: string; status: string; travel_start: string | null; relationship: "payer" | "traveller" | "payer_and_traveller" }[];
  const ROLE = { payer: "Pays (not travelling)", traveller: "Traveller", payer_and_traveller: "Pays and travels" } as const;
  return (
    <Card pad={false}>
      {error ? <p className="p-4 text-red-700">Could not load the case history. Refresh to try again.</p> : data.length === 0 ? <p className="p-4 text-muted">No cases yet.</p> : (
        <Table head={["MAX ID", "Title", "Travel", "Role", "Status"]}>
          {data.map((c) => (
            <tr key={c.id} className="relative hover:bg-gray-50">
              <td data-label="MAX ID" className="font-mono text-[13px] font-semibold"><Link href={`/cases/${c.id}`} className="after:absolute after:inset-0">{c.max_id}</Link></td>
              <td data-label="Title">{c.title}</td>
              <td data-label="Travel">{fdate(c.travel_start) || "—"}</td>
              <td data-label="Role">{ROLE[c.relationship] ?? c.relationship}</td>
              <td data-label="Status"><StatusBadge status={c.status} /></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

async function ActivityLoader({ id }: { id: string }) {
  const sb = await createClient();
  const { data } = await sb.from("activity_log").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(200);
  return <Card><ActivityList items={data ?? []} /></Card>;
}
