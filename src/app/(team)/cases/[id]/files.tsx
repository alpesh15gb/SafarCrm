"use client";
import { useState } from "react";
import { Paperclip, Upload } from "lucide-react";
import { PersonDialog } from "@/components/person-dialog";
import { Button, Card, Empty, Field, ServiceIcon } from "@/components/ui";
import { useAction } from "@/components/client";
import { DropZone, FileItem, withHistory, type FileItemData } from "@/components/files";
import { attachDocument } from "@/actions/files";
import { FILE_KINDS, SERVICE_LABEL } from "@/lib/constants";
import { expiryLabel } from "@/lib/format";
import type { Line } from "./bookings";

export type FileRow = FileItemData & { superseded_by: string | null };

export function FilesTab({ caseId, maxId, customer, files, docs, lines, travellers }: {
  caseId: string; maxId: string; customer: { full_name: string; mobile: string; whatsapp: string | null; email: string | null };
  files: FileRow[]; docs: { id: string; customer_id: string; doc_type: string; file_name: string; expiry: string | null; customer: { full_name: string } }[]; lines: Line[];
  travellers: { id: string; full_name: string }[];
}) {
  const { run, pending } = useAction();
  const [upload, setUpload] = useState<string | null>(null);
  const [kind, setKind] = useState("document");
  const [doc, setDoc] = useState("");
  const grouped = withHistory(files);
  const caseLevel = grouped.filter((g) => !g.file.booking_line_id);
  const attached = new Set(files.map((f) => (f as unknown as { source_document_id: string | null }).source_document_id).filter(Boolean));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        {lines.map((l) => {
          const lf = grouped.filter((g) => g.file.booking_line_id === l.id);
          if (!lf.length) return null;
          return (
            <Card key={l.id} title={<span className="flex items-center gap-2"><ServiceIcon service={l.service} />{SERVICE_LABEL[l.service]}{l.summary && ` · ${l.summary}`}</span>}>
              <div className="space-y-2">{lf.map(({ file, history }) => <FileItem key={file.id} f={file} history={history} maxId={maxId} customer={customer} />)}</div>
            </Card>
          );
        })}
        <Card title="Case files">
          <div className="space-y-2">
            {caseLevel.length === 0 && grouped.length === 0 && <Empty text="No files yet. Upload tickets on each booking, or general files here." />}
            {caseLevel.map(({ file, history }) => <FileItem key={file.id} f={file} history={history} maxId={maxId} customer={customer} />)}
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <Field label="Type" className="w-40">
                <select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{FILE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
              </Field>
              <div className="min-w-60 flex-1"><DropZone compact fields={{ target: "case", case_id: caseId, kind }} label="Drop files here or click to upload" /></div>
            </div>
          </div>
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
      <Card title="Traveller documents" pad={false}>
        {travellers.length === 0 ? <p className="p-4 text-sm text-muted">No travellers on this case yet. Add them on the Overview tab.</p> : (
          <ul>
            {travellers.map((t) => {
              const mine = [...new Set(docs.filter((d) => d.customer_id === t.id).map((d) => d.doc_type))];
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 last:border-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t.full_name}</div>
                    <div className={mine.length ? "text-xs text-muted" : "text-xs text-amber-700"}>{mine.length ? mine.join(", ") : "No documents yet"}</div>
                  </div>
                  <Button size="sm" onClick={() => setUpload(t.id)}><Upload className="h-3.5 w-3.5" />Upload</Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Attach to this case">
        {docs.length === 0 ? <p className="text-sm text-muted">Once travellers have documents on file, you can attach copies to this case here.</p> : (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">Reuse a passport, visa or ID already on file. Attached documents are hidden from the client unless you switch them on.</p>
            <select className="field" value={doc} onChange={(e) => setDoc(e.target.value)}>
              <option value="">Choose a document</option>
              {docs.map((d) => {
                const exp = expiryLabel(d.expiry);
                return <option key={d.id} value={d.id} disabled={attached.has(d.id)}>{d.customer.full_name} · {d.doc_type}{exp ? ` (${exp.text.toLowerCase()})` : ""}{attached.has(d.id) ? " · attached" : ""}</option>;
              })}
            </select>
            <Button disabled={!doc || pending} onClick={() => run(() => attachDocument(caseId, doc), { then: () => setDoc("") })}><Paperclip className="h-4 w-4" />Attach to {maxId}</Button>
          </div>
        )}
      </Card>
      </div>
      {upload && <PersonDialog personId={upload} startOn="docs" onClose={() => setUpload(null)} />}
    </div>
  );
}
