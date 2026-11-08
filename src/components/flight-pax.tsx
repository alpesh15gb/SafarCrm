"use client";

import { AlertTriangle, ExternalLink, Info } from "lucide-react";
import { Badge, cx } from "./ui";
import { CopyButton } from "./client";
import { IATA_TRAVEL_CENTRE, PAX_LABEL, iataName, missingForAirline, paxType, type Issue, type PaxSource } from "@/lib/iata";
import { todayIST } from "@/lib/format";

export type Pax = PaxSource & { id: string };

/** Each passenger written the way the airline needs it, with a copy button and anything still missing. */
export function FlightPassengers({ pax, travelDate, international }: { pax: Pax[]; travelDate: string | null; international: boolean }) {
  if (!pax.length) return null;
  const on = travelDate || todayIST();
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs font-medium text-muted">
        <span>Passengers, as the airline needs them</span>
        {international && (
          <a href={IATA_TRAVEL_CENTRE} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 link">
            Check entry rules (IATA) <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <ul className="divide-y divide-line">
        {pax.map((p) => {
          const type = paxType(p.dob, on);
          const n = iataName(p, type);
          const missing = missingForAirline(p, international);
          return (
            <li key={p.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-semibold tracking-wide">{n.text || p.full_name}</span>
                <CopyButton text={n.text || p.full_name} />
                {type && <Badge tone={type === "ADT" ? "grey" : "blue"}>{PAX_LABEL[type]}</Badge>}
                {!n.fromPassport && <span className="text-[11px] text-muted">from profile name, not passport</span>}
              </div>
              {missing.length > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5" />Add {missing.join(", ")} on {p.full_name}&apos;s profile{international ? ". Airlines check these before an international flight." : "."}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function IssueList({ issues }: { issues: (Issue | null)[] }) {
  const list = issues.filter(Boolean) as Issue[];
  if (!list.length) return null;
  return (
    <ul className="space-y-1">
      {list.map((i, k) => (
        <li key={k} className={cx("flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]", i.tone === "red" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900")}>
          {i.tone === "red" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{i.text}
        </li>
      ))}
    </ul>
  );
}
