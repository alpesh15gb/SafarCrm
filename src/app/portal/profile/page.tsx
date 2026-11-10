import { createClient } from "@/lib/supabase/server";
import { Badge, Card, KV } from "@/components/ui";
import { PortalProfileForm, PortalUpload } from "../client";
import { expiryLabel, fdate, prettyPhone } from "@/lib/format";

export const metadata = { title: "My profile" };

type P = Record<string, string | null> & { allow_uploads: boolean; documents: { id: string; doc_type: string; expiry: string | null; status: string; has_file: boolean; created_at: string }[] };

export default async function PortalProfile() {
  const sb = await createClient();
  const [{ data }, { data: fam }] = await Promise.all([sb.rpc("portal_profile"), sb.rpc("portal_family")]);
  const p = data as P;
  const family = (fam ?? []) as { id: string; full_name: string; relation: string | null; documents: { doc_type: string; expiry: string | null; status: string }[] }[];
  const exp = expiryLabel(p.passport_expiry);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">My profile</h1>
      <Card title="About me">
        <KV cols={3} items={[["Name", p.full_name], ["Customer code", p.code], ["Mobile", prettyPhone(p.mobile)], ["Date of birth", fdate(p.dob)],
          ["Passport expiry", exp ? <Badge tone={exp.tone}>{exp.text}</Badge> : ""]]} />
        <p className="mt-3 text-xs text-muted">To change your name, date of birth or passport details, please contact the office.</p>
      </Card>
      <Card title="Contact and preferences"><PortalProfileForm profile={p} /></Card>
      <Card title="My documents" pad={false}>
        {p.documents.length === 0 ? <p className="p-4 text-sm text-muted">No documents yet.</p> : (
          <ul>
            {p.documents.map((d) => {
              const e = expiryLabel(d.expiry);
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 last:border-0">
                  <span className="flex-1">{d.doc_type}</span>
                  {d.status === "pending_review" && <Badge tone="amber">Pending review</Badge>}
                  {e && <Badge tone={e.tone}>{e.text}</Badge>}
                  {d.has_file && <a className="text-sm link" href={`/api/docs/${d.id}`} target="_blank" rel="noreferrer">View</a>}
                </li>
              );
            })}
          </ul>
        )}
        {p.allow_uploads && <div className="border-t border-line p-4"><div className="mb-2 text-sm font-medium">Upload a new document</div><PortalUpload me={{ id: "", full_name: String(p.full_name) }} family={family} /></div>}
      </Card>
      {family.length > 0 && (
        <Card title="My family's documents" pad={false}>
          <ul>
            {family.map((f) => (
              <li key={f.id} className="border-b border-line px-4 py-2.5 last:border-0">
                <div className="text-sm font-medium">{f.full_name}{f.relation && <span className="font-normal text-muted"> · {f.relation}</span>}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {f.documents.length === 0 ? <span className="text-xs text-muted">No documents yet. Upload above and choose their name.</span>
                    : f.documents.map((d, i) => { const e = expiryLabel(d.expiry); return <Badge key={i} tone={d.status === "pending_review" ? "amber" : e && e.tone !== "grey" ? e.tone : "green"}>{d.doc_type}{d.status === "pending_review" ? " · pending review" : e ? ` · ${e.text.toLowerCase()}` : ""}</Badge>; })}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
