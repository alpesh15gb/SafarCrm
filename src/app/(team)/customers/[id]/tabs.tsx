"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Eye, FileText, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, Card, Empty, Field, Table } from "@/components/ui";
import { Confirm, CopyButton, Dialog, Menu, useAction } from "@/components/client";
import { DropZone } from "@/components/files";
import { deleteCustomer, deleteDocument, inviteToPortal, revokePortal, saveDocumentMeta } from "@/actions/customers";
import { STATUS_LABEL } from "@/lib/constants";
import { expiryLabel, fdatetime } from "@/lib/format";

export function CustomerActions({ customer, isBoss, hasPortal }: { customer: { id: string; full_name: string }; isBoss: boolean; hasPortal: boolean }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [invite, setInvite] = useState<{ login: string; password: string; wa: string; text: string } | null>(null);
  const [del, setDel] = useState(false);
  if (!isBoss) return null;
  return (
    <>
      <Menu trigger={<Button aria-label="More" className="!px-2"><MoreHorizontal className="h-4 w-4" /></Button>}>
        <button type="button" onClick={() => run(() => inviteToPortal(customer.id), { then: (r) => setInvite(r.data as typeof invite) })}>
          {hasPortal ? "Reset portal password" : "Invite to portal"}
        </button>
        {hasPortal && <button type="button" onClick={() => run(() => revokePortal(customer.id))}>Switch off portal access</button>}
        <button type="button" className="text-red-600" onClick={() => setDel(true)}>Delete customer</button>
      </Menu>
      <Dialog open={!!invite} onClose={() => setInvite(null)} title="Portal login ready"
        footer={<><Button onClick={() => setInvite(null)}>Done</Button><a className="inline-flex h-9 items-center rounded-lg bg-coral px-3.5 text-sm font-medium text-white" href={invite?.wa} target="_blank" rel="noreferrer">Send on WhatsApp</a></>}>
        {invite && (
          <div className="space-y-3 text-sm">
            <p>Send these details to {customer.full_name}. They will set their own password on first login.</p>
            <div className="rounded-lg bg-gray-50 p-3">
              <div>Login: <b>{invite.login}</b> <CopyButton text={invite.login} /></div>
              <div>Temporary password: <b className="font-mono">{invite.password}</b> <CopyButton text={invite.password} /></div>
            </div>
            <pre className="whitespace-pre-wrap rounded-lg border border-line p-3 font-sans text-[13px] text-muted">{invite.text}</pre>
          </div>
        )}
      </Dialog>
      <Confirm open={del} onClose={() => setDel(false)} title={`Delete ${customer.full_name}?`} text="Their documents are deleted too. Customers with cases cannot be deleted." confirmLabel="Delete" pending={pending}
        onConfirm={() => run(() => deleteCustomer(customer.id), { then: () => { setDel(false); router.push("/customers"); } })} />
    </>
  );
}

type Doc = { id: string; customer_id: string; owner: string; doc_type: string; expiry: string | null; note: string | null; file_name: string | null; mime: string | null; status: string; created_at: string; has_file: boolean; number: string | null; uploader: { full_name: string; role: string } | null };
type Person = { id: string; full_name: string; relation: string | null };

export function DocumentsTab({ customerId, docs, types, people }: { customerId: string; docs: Doc[]; types: string[]; people: Person[] }) {
  const { run, pending } = useAction();
  const [type, setType] = useState(types[0] ?? "Other");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [forId, setForId] = useState(customerId);
  const [edit, setEdit] = useState<Doc | null>(null);
  const [del, setDel] = useState<Doc | null>(null);
  const [view, setView] = useState<Doc | null>(null);
  const family = people.length > 1;

  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card pad={false}>
        {docs.length === 0 ? <Empty text="No documents yet. Upload Aadhaar, PAN, passport or visa copies once and reuse them on every case." /> : (
          <Table head={["Document", "Number", "Expiry", "Uploaded", ""]}>
            {docs.map((d) => {
              const exp = expiryLabel(d.expiry);
              return (
                <tr key={d.id}>
                  <td data-label="Document">
                    <div className="flex items-center gap-3">
                      {/* small preview; a click opens it large (owner, 2026-11-28) */}
                      {d.has_file ? (
                        <button type="button" onClick={() => setView(d)} aria-label={`Preview ${d.doc_type}`}
                          className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-gray-50 transition-shadow hover:shadow-lift">
                          {d.mime?.startsWith("image/")
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={`/api/docs/${d.id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                            : <span className="flex flex-col items-center text-red-600"><FileText className="h-5 w-5" /><span className="text-[9px] font-semibold">PDF</span></span>}
                        </button>
                      ) : <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-line"><FileText className="h-5 w-5 text-muted" /></span>}
                      <div>
                        <div className="font-medium">{d.doc_type}</div>
                        {family && <div className={d.customer_id === customerId ? "text-xs text-muted" : "text-xs font-medium text-sky-700"}>{d.owner}</div>}
                        {d.status === "pending_review" && <Badge tone="amber">{STATUS_LABEL.pending_review}</Badge>}
                        {d.note && <div className="text-xs text-muted">{d.note}</div>}
                      </div>
                    </div>
                  </td>
                  <td data-label="Number" className="font-mono text-[13px]">{d.number ?? "—"}</td>
                  <td data-label="Expiry">{exp ? <Badge tone={exp.tone}>{exp.text}</Badge> : "—"}</td>
                  <td data-label="Uploaded" className="text-xs text-muted">{fdatetime(d.created_at)}{d.uploader && <div>{d.uploader.role === "client" ? "by client" : d.uploader.full_name}</div>}</td>
                  <td data-label="">
                    <span className="flex justify-end gap-1">
                      {d.status === "pending_review" && <Button size="sm" onClick={() => run(() => saveDocumentMeta(d.id, { doc_type: d.doc_type, expiry: d.expiry ?? "", note: d.note ?? "", status: "ok" }))}><Check className="h-3.5 w-3.5" />Reviewed</Button>}
                      {d.has_file && <button type="button" className="rounded p-1.5 text-muted hover:bg-gray-100" aria-label="Preview" onClick={() => setView(d)}><Eye className="h-4 w-4" /></button>}
                      {d.has_file && <a className="rounded p-1.5 text-muted hover:bg-gray-100" href={`/api/docs/${d.id}?dl=1`} aria-label="Download"><Download className="h-4 w-4" /></a>}
                      <button type="button" className="rounded p-1.5 text-muted hover:bg-gray-100" aria-label="Edit" onClick={() => setEdit(d)}><Pencil className="h-4 w-4" /></button>
                      <button type="button" className="rounded p-1.5 text-muted hover:bg-gray-100 hover:text-red-600" aria-label="Delete" onClick={() => setDel(d)}><Trash2 className="h-4 w-4" /></button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <Card title="Upload a document">
        <div className="space-y-3">
          {family && (
            <Field label="Whose document?">
              <select className="field" value={forId} onChange={(e) => setForId(e.target.value)}>
                {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.relation ? ` (${p.relation})` : ""}</option>)}
              </select>
            </Field>
          )}
          <Field label="Document type"><select className="field" value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Number" hint="Optional; stored encrypted"><input className="field font-mono" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Expiry" hint="Feeds reminders 6 months ahead"><input type="date" className="field" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
          <DropZone fields={{ target: "customer_doc", customer_id: forId, doc_type: type, number, expiry }} label="Drop file or click (PDF, JPG, PNG · 10 MB)" onDone={() => { setNumber(""); setExpiry(""); }} />
        </div>
      </Card>
      <DocEdit doc={edit} types={types} onClose={() => setEdit(null)} />
      <Dialog open={!!view} onClose={() => setView(null)} title={view ? `${view.doc_type}${family ? ` · ${view.owner}` : ""}` : ""} wide>
        {view && (view.mime?.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={`/api/docs/${view.id}`} alt={view.doc_type} className="mx-auto max-h-[75vh] w-auto rounded-lg border border-line" />
          : <iframe src={`/api/docs/${view.id}`} title={view.doc_type} className="h-[75vh] w-full rounded-lg border border-line" />)}
        {view && <div className="mt-3 flex justify-end"><a className="text-sm link" href={`/api/docs/${view.id}?dl=1`}>Download</a></div>}
      </Dialog>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Delete this document?" text={del?.doc_type} confirmLabel="Delete" pending={pending}
        onConfirm={() => del && run(() => deleteDocument(del.id), { then: () => setDel(null) })} />
    </div>
  );
}

function DocEdit({ doc, types, onClose }: { doc: Doc | null; types: string[]; onClose: () => void }) {
  const { run, pending } = useAction();
  const [v, setV] = useState({ doc_type: "", number: "", expiry: "", note: "" });
  const [cur, setCur] = useState<string | null>(null);
  if (doc && cur !== doc.id) { setCur(doc.id); setV({ doc_type: doc.doc_type, number: "", expiry: doc.expiry ?? "", note: doc.note ?? "" }); }
  if (!doc) return null;
  return (
    <Dialog open={!!doc} onClose={() => { setCur(null); onClose(); }} title="Edit document"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending}
        onClick={() => run(() => saveDocumentMeta(doc.id, { ...v, number: v.number || undefined, status: "ok" }), { then: () => { setCur(null); onClose(); } })}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type"><select className="field" value={v.doc_type} onChange={(e) => setV({ ...v, doc_type: e.target.value })}>{[...new Set([v.doc_type, ...types])].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Number" hint={doc.number ? `Current: ${doc.number}. Leave blank to keep.` : undefined}><input className="field font-mono" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} /></Field>
        <Field label="Expiry"><input type="date" className="field" value={v.expiry} onChange={(e) => setV({ ...v, expiry: e.target.value })} /></Field>
        <Field label="Note"><input className="field" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
