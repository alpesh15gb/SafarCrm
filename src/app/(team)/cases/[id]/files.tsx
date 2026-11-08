"use client";
import { useState } from "react";
import { Paperclip } from "lucide-react";
import { Button, Card, Empty, Field, ServiceIcon } from "@/components/ui";
import { useAction } from "@/components/client";
import { DropZone, FileItem, withHistory, type FileItemData } from "@/components/files";
import { attachDocument } from "@/actions/files";
import { FILE_KINDS, SERVICE_LABEL } from "@/lib/constants";
import { expiryLabel } from "@/lib/format";
import type { Line } from "./bookings";

export type FileRow = FileItemData & { superseded_by: string | null };

export function FilesTab({ caseId, maxId, customer, files, docs, lines }: {
  caseId: string; maxId: string; customer: { full_name: string; mobile: string; whatsapp: string | null; email: string | null };
  files: FileRow[]; docs: { id: string; doc_type: string; file_name: string; expiry: string | null; customer: { full_name: string } }[]; lines: Line[];
}) {
  const { run, pending } = useAction();
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
      <Card title="Attach from customer documents">
        {docs.length === 0 ? <p className="text-sm text-muted">Travellers on this case have no uploaded documents yet.</p> : (
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
  );
}
