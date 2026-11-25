import { useId } from "react";
import { Field } from "@/components/ui";
import type { BookingPrice } from "@/lib/money";

export const EMPTY_BOOKING_PRICE: BookingPrice<string> = {
  supplier_cost: "", selling_price: "", commission_type: "amount", commission_value: "", gst: "",
};

export function BookingPriceFields({ price, onChange, visa, perPerson, showCommission, keepCost }: {
  price: BookingPrice<string>;
  onChange: (price: BookingPrice<string>) => void;
  visa: boolean;
  perPerson?: boolean;
  showCommission: boolean;
  keepCost?: boolean;
}) {
  const commissionId = useId();
  const suffix = perPerson ? ", per person" : "";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={visa ? "Our cost (₹)" : "Supplier cost (₹)"}
        hint={keepCost ? "Hidden. Leave empty to keep the cost already saved." : visa ? `Embassy + VFS fees${suffix}` : undefined}>
        <input className="field tabular" inputMode="decimal" placeholder={keepCost ? "Hidden" : undefined} value={price.supplier_cost}
          onChange={(e) => onChange({ ...price, supplier_cost: e.target.value })} />
      </Field>
      <Field label={visa ? "Charge to client (₹)" : "Selling price (₹)"} hint={visa ? `Fees + our service charge${suffix}` : "Without GST"}>
        <input className="field tabular" inputMode="decimal" value={price.selling_price}
          onChange={(e) => onChange({ ...price, selling_price: e.target.value })} />
      </Field>
      {!visa && showCommission && (
        <div>
          <label htmlFor={commissionId} className="mb-1 block text-[13px] font-medium text-ink">Commission</label>
          <div className="flex">
            <input id={commissionId} className="field min-w-0 tabular !rounded-r-none" inputMode="decimal"
              value={price.commission_value} onChange={(e) => onChange({ ...price, commission_value: e.target.value })} />
            <select className="field !w-16 shrink-0 !rounded-l-none !border-l-0 !px-2" aria-label="Commission type" value={price.commission_type}
              onChange={(e) => onChange({ ...price, commission_type: e.target.value === "percent" ? "percent" : "amount" })}>
              <option value="amount">₹</option>
              <option value="percent">%</option>
            </select>
          </div>
        </div>
      )}
      <Field label="GST (₹, optional)" hint={perPerson ? "Per person" : undefined}>
        <input className="field tabular" inputMode="decimal" value={price.gst} onChange={(e) => onChange({ ...price, gst: e.target.value })} />
      </Field>
    </div>
  );
}
