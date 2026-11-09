import ExcelJS from "exceljs";
import { getMe } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listCases, listCustomers, listSuppliers } from "@/lib/queries";
import { REPORTS, runReport, type Col } from "@/lib/reports";
import { SERVICE_LABEL, STATUS_LABEL, SUPPLIER_TYPE_LABEL, type Service } from "@/lib/constants";
import { fdate, todayIST } from "@/lib/format";

// Indian digit grouping (₹1,25,000)
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0;[>=100000]"₹"##\\,##\\,##0;"₹"#,##0;-"₹"#,##0';

/** A real Excel date (so sorting and filters work). Timestamps are shown in India time. */
function excelDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute));
}

function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[], totals?: Record<string, unknown>) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = cols.map((c) => ({ header: c.label || name, key: c.key, width: Math.max(12, (c.label || "").length + 4), style: c.money ? { numFmt: INR } : {} }));
  for (const r of rows) {
    ws.addRow(Object.fromEntries(cols.map((c) => [c.key, c.money ? (r[c.key] === null || r[c.key] === undefined ? null : Number(r[c.key])) : c.date ? excelDate(r[c.key]) : r[c.key] ?? ""])));
  }
  // dates: real Excel dates shown as DD-MM-YYYY (with time for timestamps)
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.eachCell((cell) => {
      if (cell.value instanceof Date) cell.numFmt = cell.value.getUTCHours() || cell.value.getUTCMinutes() ? "dd-mm-yyyy hh:mm" : "dd-mm-yyyy";
    });
  });
  if (totals) {
    const row = ws.addRow(Object.fromEntries(cols.map((c) => [c.key, totals[c.key] ?? ""])));
    row.font = { bold: true };
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.columns.forEach((col) => {
    let w = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => { w = Math.max(w, cell.value instanceof Date ? 17 : String(cell.value ?? "").length + 2); });
    col.width = Math.min(w, 50);
  });
  return ws;
}

async function respond(wb: ExcelJS.Workbook, name: string) {
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}_${fdate(todayIST())}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: Request) {
  const me = await getMe();
  if (!me || me.role === "client" || me.mfa_pending) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams) as Record<string, string>;
  // "export" names what to export; every other parameter is the list's own filters (e.g. type=individual)
  let kind = sp.export ?? "";
  // old links used ?type=customers; keep them working
  if (!kind && ["cases", "customers", "suppliers", "report", "all"].includes(sp.type)) { kind = sp.type; delete sp.type; }
  const wb = new ExcelJS.Workbook();
  wb.creator = "Safar CRM";

  try {
    if (kind === "cases") {
      const { rows } = await listCases(sp, true);
      const cols: Col[] = [{ key: "max_id", label: "MAX ID" }, { key: "title", label: "Title" }, { key: "customer", label: "Customer" }, { key: "mobile", label: "Mobile" },
        { key: "travel_start", label: "Travel start", date: true }, { key: "travel_end", label: "Travel end", date: true }, { key: "destination", label: "Destination" },
        { key: "services", label: "Services" }, { key: "staff", label: "Staff" }, { key: "status", label: "Status" },
        { key: "billed", label: "Billed", money: true }, { key: "received", label: "Received", money: true }, { key: "due", label: "Due", money: true },
        ...(me.can_see_profit ? [{ key: "profit", label: "Profit", money: true } as Col] : [])];
      addSheet(wb, "Cases", cols, rows.map((r) => ({
        ...r, customer: r.customer?.full_name, mobile: r.customer?.mobile, staff: r.staff?.full_name, status: STATUS_LABEL[r.status],
        services: [...new Set(r.lines.map((l) => SERVICE_LABEL[l.service as Service]))].join(", "), ...r.money,
      })));
      return respond(wb, "Cases");
    }
    if (kind === "customers") {
      const { rows } = await listCustomers(sp, true);
      addSheet(wb, "Customers", [{ key: "code", label: "Code" }, { key: "full_name", label: "Name" }, { key: "customer_type", label: "Type" }, { key: "mobile", label: "Mobile" },
        { key: "email", label: "Email" }, { key: "city", label: "City" }, { key: "dob", label: "Date of birth", date: true }, { key: "passport_expiry", label: "Passport expiry", date: true },
        { key: "tags", label: "Tags" }, { key: "family", label: "Family" }, { key: "lead_source", label: "Lead source" }, { key: "cases", label: "Cases" }],
        rows.map((r) => ({ ...r, tags: r.tags.join(", "), family: r.family?.name, cases: r.cases?.[0]?.count ?? 0 })));
      return respond(wb, "Customers");
    }
    if (kind === "suppliers") {
      const { rows } = await listSuppliers(sp, true);
      addSheet(wb, "Suppliers", [{ key: "name", label: "Supplier" }, { key: "type", label: "Type" }, { key: "contact_person", label: "Contact" }, { key: "mobile", label: "Mobile" },
        { key: "city", label: "City" }, { key: "terms", label: "Terms" }, { key: "payable", label: "Payable", money: true }, { key: "paid", label: "Paid", money: true }, { key: "due", label: "Due", money: true }],
        rows.map((r) => ({ ...r, type: SUPPLIER_TYPE_LABEL[r.supplier_type], terms: r.terms === "credit" ? `Credit ${r.credit_days} days` : "Prepaid", due: r.payable - r.paid })));
      return respond(wb, "Suppliers");
    }
    if (kind === "report") {
      const key = sp.r ?? "client_dues";
      const def = REPORTS.find((r) => r.key === key);
      if (!def || ("profit" in def && def.profit && !me.can_see_profit)) return new Response("Not allowed", { status: 403 });
      const rep = await runReport(key, sp);
      if (rep.sections) rep.sections.forEach((s) => addSheet(wb, s.title, s.cols, s.rows));
      else addSheet(wb, rep.title, rep.cols, rep.rows, rep.totals);
      return respond(wb, rep.title.replace(/\W+/g, "_"));
    }
    if (kind === "all") {
      if (me.role !== "boss") return new Response("Only the boss can export all data", { status: 403 });
      const sb = await createClient();
      const tables: [string, string, string][] = [
        ["Customers", "customers", "code, title, first_name, middle_name, last_name, customer_type, gender, dob, nationality, mobile, alt_mobile, whatsapp, email, address1, address2, city, state, pin, country, passport_surname, passport_given_name, passport_issue, passport_expiry, passport_place, passport_country, passport_ecr, visas, loyalty, irctc_id, seat_pref, meal_pref, emergency_name, emergency_mobile, company_name, gstin, lead_source, referred_by, tags, notes, created_at"],
        ["Families", "families", "id, name, created_at"],
        ["Suppliers", "suppliers", "*"],
        ["Cases", "cases", "max_id, title, status, cancel_reason, travel_start, travel_end, destination, lead_source, tags, notes, created_at, customer:customers!cases_customer_id_fkey(code, full_name), staff:profiles!cases_assigned_to_fkey(full_name)"],
        ["Bookings", "booking_lines", "service, status, summary, service_date, reference, supplier_cost, selling_price, commission_amount, gst, refund_to_client, refund_from_supplier, cancellation_charge, cancel_reason, payment_due_date, supplier_due_date, details, notes, created_at, case:cases(max_id), supplier:suppliers(name)"],
        ["Payments", "payments", "direction, pay_date, amount, mode, reference, notes, created_at, case:cases!payments_case_id_fkey(max_id), supplier:suppliers(name)"],
        ["Expenses", "expenses", "name, amount, exp_date, case:cases(max_id)"],
        ["Tasks", "tasks", "title, status, priority, due_at, completed_at, notes, auto_key, case:cases(max_id), assignee:profiles!tasks_assigned_to_fkey(full_name)"],
        ["Documents", "customer_documents", "doc_type, expiry, note, file_name, status, created_at, customer:customers(code, full_name)"],
        ["Files", "files", "file_name, kind, visible_to_client, superseded_at, created_at, case:cases(max_id)"],
        ["Activity", "activity_log", "created_at, actor_name, action, entity, summary"],
        ["Lookups", "lookups", "kind, value, extra"],
      ];
      for (const [name, table, sel] of tables) {
        const all: Record<string, unknown>[] = [];
        for (let from = 0; ; from += 1000) {
          // a fixed order, so pages never skip or repeat rows
          const { data, error } = await sb.from(table).select(sel).order("id").range(from, from + 999);
          if (error) throw error;
          all.push(...((data ?? []) as unknown as Record<string, unknown>[]));
          if ((data ?? []).length < 1000) break;
        }
        const flat = all.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
          v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 2 ? Object.values(v).join(" ") :
          Array.isArray(v) || (v && typeof v === "object") ? JSON.stringify(v) :
          excelDate(v) ?? v])));
        const keys = flat.length ? Object.keys(flat[0]) : sel === "*" ? [] : sel.split(",").map((s) => s.trim().split(":")[0]);
        addSheet(wb, name, keys.map((k) => ({ key: k, label: k })), flat);
      }
      return respond(wb, "Safar_all_data");
    }
    return new Response("Unknown export", { status: 400 });
  } catch (e) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Export failed";
    return new Response(msg, { status: 500 });
  }
}
