import { Field, Button } from "@/components/ui";
import { SERVICE_FIELDS, type FieldDef, type Service } from "@/lib/constants";

const LEG_FIELDS: FieldDef[] = [
  { key: "from", label: "From airport code" },
  { key: "to", label: "To airport code" },
  { key: "airline", label: "Airline" },
  { key: "flight_no", label: "Flight number" },
  { key: "date", label: "Departure date", type: "date" },
  { key: "dep", label: "Departure time", type: "time" },
  { key: "arr_date", label: "Arrival date", type: "date" },
  { key: "arr", label: "Arrival time", type: "time" },
];

function DetailField({ field, value, onChange, list }: {
  field: FieldDef; value: unknown; onChange: (v: string) => void; list?: string;
}) {
  const text = String(value ?? "");
  return (
    <Field label={field.label} hint={field.hint} className={field.type === "textarea" ? "sm:col-span-2" : undefined}>
      {field.type === "select" ? (
        <select className="field" value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {text && !field.options?.includes(text) && <option value={text}>{text}</option>}
          {field.options?.map((option) => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}
        </select>
      ) : field.type === "textarea" ? (
        <textarea className="field min-h-16" value={text} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="field" type={field.type ?? "text"} list={list} value={text} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

export function BookingDetailsFields({ service, details, onChange, lookups, airportZones }: {
  service: Service;
  details: Record<string, unknown>;
  onChange: (d: Record<string, unknown>) => void;
  lookups?: boolean;
  airportZones?: Map<string, string>;
}) {
  const sectors = (details.sectors as Record<string, string>[] | undefined) ?? [];
  const setLegs = (legs: Record<string, string>[]) => onChange({ ...details, sectors: legs });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {SERVICE_FIELDS[service].main.map((field) => (
          <DetailField key={field.key} field={field} value={details[field.key]}
            list={lookups && field.list ? `dl-${field.list}` : undefined}
            onChange={(value) => onChange({ ...details, [field.key]: field.key === "pnr" ? value.toUpperCase() : value })} />
        ))}
      </div>
      {service === "flight" && <>
        {sectors.map((leg, index) => (
          <fieldset key={index} className="rounded-lg border border-line p-3">
            <legend className="px-1 text-sm font-medium">Flight leg {index + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {LEG_FIELDS.map((field) => (
                <DetailField key={field.key} field={field} value={leg[field.key]}
                  list={lookups ? field.key === "airline" ? "dl-airline" : ["from", "to"].includes(field.key) ? "dl-airport" : undefined : undefined}
                  onChange={(value) => {
                    const airport = field.key === "from" || field.key === "to";
                    const next = { ...leg, [field.key]: airport || field.key === "flight_no" ? value.toUpperCase() : value };
                    if (airport) next[field.key === "from" ? "dep_tz" : "arr_tz"] = airportZones?.get(value.trim().toUpperCase()) ?? "";
                    setLegs(sectors.map((s, i) => i === index ? next : s));
                  }} />
              ))}
            </div>
            <button type="button" className="mt-2 text-xs link" onClick={() => setLegs(sectors.filter((_, i) => i !== index))}>Remove flight leg {index + 1}</button>
          </fieldset>
        ))}
        <Button size="sm" onClick={() => setLegs([...sectors, {}])}>Add flight leg</Button>
      </>}
    </div>
  );
}
