"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button, Field } from "@/components/ui";
import { useToast } from "@/components/client";
import { DropZone } from "@/components/files";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { normPhone, phoneError } from "@/lib/format";

export function PortalLogout() {
  const router = useRouter();
  return (
    <button type="button" className="rounded-lg p-2 text-muted hover:bg-gray-50" aria-label="Log out"
      onClick={async () => { await supabaseBrowser().auth.signOut(); router.replace("/login"); router.refresh(); }}>
      <LogOut className="h-4 w-4" />
    </button>
  );
}

const EDITABLE: [string, string][] = [
  ["email", "Email"], ["alt_mobile", "Alternate mobile"], ["whatsapp", "WhatsApp"], ["address1", "Address line 1"], ["address2", "Address line 2"],
  ["city", "City"], ["state", "State"], ["pin", "PIN code"], ["seat_pref", "Seat preference"], ["meal_pref", "Meal preference"],
  ["special_assistance", "Special assistance"], ["emergency_name", "Emergency contact name"], ["emergency_relation", "Relation"], ["emergency_mobile", "Emergency contact mobile"],
];

export function PortalProfileForm({ profile }: { profile: Record<string, string | null> }) {
  const toast = useToast();
  const router = useRouter();
  const [v, setV] = useState(Object.fromEntries(EDITABLE.map(([k]) => [k, profile[k] ?? ""])));
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {EDITABLE.map(([k, l]) => <Field key={k} label={l}><input className="field" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy} onClick={async () => {
          // same phone rules as the office screens: check, then store as +91XXXXXXXXXX
          const out = { ...v };
          for (const [k, label] of [["alt_mobile", "Alternate mobile"], ["whatsapp", "WhatsApp"], ["emergency_mobile", "Emergency contact mobile"]] as const) {
            const e = phoneError(out[k]);
            if (e) return toast(`${label}: ${e}`, "error");
            out[k] = normPhone(out[k]);
          }
          setBusy(true);
          const { error } = await supabaseBrowser().rpc("portal_update_profile", { p: out });
          setBusy(false);
          if (error) return toast(/phone|mobile|digit/i.test(error.message) ? "Please check the phone numbers: 10 digits, e.g. 98765 43210." : "Sorry, your changes could not be saved. Please try again, or call the office.", "error");
          toast("Profile saved"); router.refresh();
        }}>Save changes</Button>
      </div>
    </div>
  );
}

/** me.id is "" for the logged-in client themselves (the server fills it in). */
export function PortalUpload({ me, family }: { me: { id: string; full_name: string }; family: { id: string; full_name: string; relation: string | null }[] }) {
  const [who, setWho] = useState(me.id);
  const [type, setType] = useState("Passport front");
  const [expiry, setExpiry] = useState("");
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {family.length > 0 && (
          <Field label="Whose document?">
            <select className="field" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value={me.id}>Mine ({me.full_name})</option>
              {family.map((f) => <option key={f.id} value={f.id}>{f.full_name}{f.relation ? ` (${f.relation})` : ""}</option>)}
            </select>
          </Field>
        )}
        <Field label="Document">
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {["Passport front", "Passport back", "Visa", "Aadhaar front", "Aadhaar back", "PAN", "Photo", "Other"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Expiry date (if any)"><input type="date" className="field" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
      </div>
      <DropZone fields={{ target: "portal_doc", for_customer: who, doc_type: type, expiry }} label="Drop a PDF, JPG or PNG here, or tap to choose (up to 10 MB)" />
    </div>
  );
}
