import { useRef } from "react";
import { Button, cx } from "@/components/ui";

export function TicketPick({ file, onPick }: { file: File | null; onPick: (f: File | null, error: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const take = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(pdf|jpe?g|png)$/i.test(f.name)) return onPick(file, `${f.name}: choose a PDF, JPG or PNG.`);
    if (f.size > 10 * 1024 * 1024) return onPick(file, `${f.name} is larger than 10 MB.`);
    onPick(f, "");
  };
  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files[0]); }}
      className={cx("flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm", file ? "border-emerald-300 bg-emerald-50" : "border-line")}>
      <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
      {file
        ? <><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span><button type="button" className="text-xs text-muted hover:text-red-600" onClick={() => onPick(null, "")}>Remove</button></>
        : <><span className="min-w-0 flex-1 text-muted">Drop the file here, or</span><Button size="sm" onClick={() => input.current?.click()}>Choose file</Button></>}
    </div>
  );
}
