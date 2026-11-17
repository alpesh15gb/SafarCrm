import { test as base, expect, type Page } from "@playwright/test";
import type { WebsiteEnquiry } from "../../src/components/website-enquiries";

const staff = [{ id: "11111111-1111-4111-8111-111111111111", full_name: "Synthetic Admin", role: "boss" }, { id: "22222222-2222-4222-8222-222222222222", full_name: "Synthetic Advisor", role: "staff" }];
const sample: WebsiteEnquiry = {
  id: "33333333-3333-4333-8333-333333333333", reference: "ME-SYNTHETIC-001", service: "HOLIDAY", status: "NEW", version: 1, environment: "live",
  createdAt: "2026-11-18T05:30:00Z", updatedAt: "2026-11-18T05:30:00Z", consentAt: "2026-11-18T05:29:00Z", contactVerified: false, assignedTo: null, internalNote: "",
  contact: { name: "Synthetic Traveller", email: "traveller@example.test", phone: "+919876543210", preferredChannel: "WHATSAPP" },
  draft: { destination: "Bali", travelWindow: "December 2026, dates flexible", adults: 2, childAges: [6], departureCity: "Hyderabad", durationNights: 5, nationality: "India", purpose: "Family holiday", countryOfResidence: "India", notes: "Vegetarian meals and a quiet beach stay" },
  requestedBudget: { amountRupees: 80000, basis: "TOTAL" },
};
type Fixture = { rows: WebsiteEnquiry[]; canAssign: boolean; status: number; patchStatus: number; hasMore: boolean; calls: { method: string; url: URL; body: Record<string, unknown> | null }[] };
const test = base.extend<{ inbox: Fixture }>({
  inbox: async ({ page }, provide) => {
    const inbox: Fixture = { rows: [structuredClone(sample)], canAssign: true, status: 200, patchStatus: 200, hasMore: false, calls: [] };
    const unexpected: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:3219") { unexpected.push(url.origin + url.pathname); return route.abort(); }
      if (["/", "/enquiries", "/fixture.js", "/fixture.css", "/favicon.ico"].includes(url.pathname)) return route.continue();
      if (url.pathname !== "/api/enquiries") { unexpected.push(request.method() + " " + url.pathname); return route.abort(); }
      const body = request.method() === "PATCH" ? request.postDataJSON() : null;
      inbox.calls.push({ method: request.method(), url, body });
      const status = request.method() === "PATCH" ? inbox.patchStatus : inbox.status;
      if (status !== 200) return route.fulfill({ status, json: { error: status === 409 ? "Version conflict" : status === 403 ? "Enquiry access required" : "Temporarily unavailable" } });
      if (body) {
        const previous = inbox.rows.find(row => row.id === body.id)!;
        const row = { ...previous, status: body.status, internalNote: body.internalNote, version: previous.version + 1, ...(Object.hasOwn(body, "assignedTo") ? { assignedTo: body.assignedTo } : {}) } as WebsiteEnquiry;
        inbox.rows = inbox.rows.map(item => item.id === row.id ? row : item);
        return route.fulfill({ json: { enquiry: row } });
      }
      const rows = inbox.rows.filter(row => row.environment === (url.searchParams.get("environment") || "live"));
      return route.fulfill({ json: { rows, page: Number(url.searchParams.get("page") || 1), total: rows.length, hasMore: inbox.hasMore, canAssign: inbox.canAssign, staff } });
    });
    await provide(inbox);
    expect(unexpected, "UI must not contact live services or other CRM mutation endpoints").toEqual([]);
    expect(pageErrors, "No browser runtime errors").toEqual([]);
  },
});

async function open(page: Page) {
  await page.goto("/enquiries");
  await page.getByRole("button", { name: `Open enquiry ${sample.reference}`, exact: true }).click();
  return page.getByRole("region", { name: `Enquiry ${sample.reference}`, exact: true });
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }

test("native inbox and structured details remain readable with explicit unverified contact and no transaction actions", async ({ page, inbox }, info) => {
  await page.goto("/enquiries");
  await expect(page.getByRole("list", { name: "Website enquiry results" })).toContainText("Bali");
  await page.screenshot({ path: info.outputPath("enquiry-inbox.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: `Open enquiry ${sample.reference}`, exact: true }).click();
  const detail = page.getByRole("region", { name: `Enquiry ${sample.reference}`, exact: true });
  await expect(detail).toContainText("Unverified contact");
  await expect(detail).toContainText("₹80,000 total");
  await expect(detail).toContainText("Customer preference, not a quote or payment.");
  await expect(detail).toContainText("traveller@example.test");
  await expect(detail).toContainText("Contact consent received");
  await expect(detail.getByRole("button", { name: /create|book|pay|send/i })).toHaveCount(0);
  expect(inbox.calls.every(call => call.method === "GET")).toBe(true);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("enquiry-detail.png"), fullPage: true, animations: "disabled" });
});

test("administrator assignment and follow-up save exactly the viewed version without creating other records", async ({ page, inbox }) => {
  const detail = await open(page);
  await detail.getByLabel("Assigned to", { exact: true }).selectOption(staff[1].id);
  await detail.getByLabel("Enquiry status", { exact: true }).selectOption("CONTACTED");
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("Customer requested options for next month.");
  const form = detail.getByRole("form", { name: "Enquiry follow-up" });
  await form.evaluate((element: HTMLFormElement) => { element.requestSubmit(); element.requestSubmit(); });
  await expect(page.getByRole("status")).toContainText("updated");
  const writes = inbox.calls.filter(call => call.method === "PATCH");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({ id: sample.id, version: 1, status: "CONTACTED", internalNote: "Customer requested options for next month.", assignedTo: staff[1].id });
  await expect(detail.getByRole("button", { name: "Save follow-up" })).toBeDisabled();
});

test("staff view hides assignment controls and unprojected budget while allowing scoped follow-up", async ({ page, inbox }) => {
  inbox.canAssign = false;
  inbox.rows = [{ ...sample, assignedTo: staff[1].id, requestedBudget: null }];
  const detail = await open(page);
  await expect(detail.getByLabel("Assigned to", { exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText("Requested budget");
  await expect(detail).not.toContainText("80,000");
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("Follow up tomorrow.");
  await detail.getByRole("button", { name: "Save follow-up", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("updated");
  expect(inbox.calls.find(call => call.method === "PATCH")?.body).not.toHaveProperty("assignedTo");
});

for (const failure of [409, 503]) test(`${failure} update requires refresh before retrying and preserves the typed note`, async ({ page, inbox }) => {
  inbox.patchStatus = failure;
  const detail = await open(page);
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("Keep this follow-up for comparison.");
  await detail.getByRole("button", { name: "Save follow-up", exact: true }).click();
  await expect(detail.getByRole("alert")).toBeVisible();
  await expect(detail.getByLabel("Internal follow-up note", { exact: true })).toHaveValue("Keep this follow-up for comparison.");
  await expect(detail.getByLabel("Internal follow-up note", { exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Save follow-up", exact: true })).toHaveCount(0);
  inbox.rows = [{ ...sample, version: 2, internalNote: "Updated by another advisor." }];
  inbox.patchStatus = 200;
  await detail.getByRole("button", { name: "Refresh enquiry", exact: true }).click();
  await expect(detail.getByLabel("Internal follow-up note", { exact: true })).toHaveValue("Updated by another advisor.");
  await detail.getByLabel("Enquiry status", { exact: true }).selectOption("CONTACTED");
  await detail.getByRole("button", { name: "Save follow-up", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("updated");
  expect(inbox.calls.filter(call => call.method === "PATCH").map(call => call.body?.version)).toEqual([1, 2]);
});

test("access loss clears contact and detail instead of retaining stale private records", async ({ page, inbox }) => {
  const detail = await open(page);
  inbox.patchStatus = 403;
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("Attempted note.");
  await detail.getByRole("button", { name: "Save follow-up", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("access has changed");
  await expect(page.getByText("traveller@example.test", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: `Enquiry ${sample.reference}`, exact: true })).toHaveCount(0);
});

test("search filters and pagination are submitted explicitly, with distinguishable empty and failed states", async ({ page, inbox }) => {
  inbox.hasMore = true;
  await page.goto("/enquiries");
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await page.getByLabel("Search enquiries", { exact: true }).fill("Bali");
  await page.getByLabel("Service", { exact: true }).selectOption("HOLIDAY");
  await page.getByLabel("Status", { exact: true }).selectOption("NEW");
  expect(inbox.calls).toHaveLength(1);
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect.poll(() => inbox.calls.length).toBe(2);
  expect(Object.fromEntries(inbox.calls[1].url.searchParams)).toEqual({ q: "Bali", service: "HOLIDAY", status: "NEW", page: "1", environment: "live" });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  inbox.rows = []; inbox.hasMore = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("No enquiries match these filters.", { exact: true })).toBeVisible();
  inbox.status = 503;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Temporarily unavailable");
  await expect(page.getByText("No enquiries match these filters.", { exact: true })).toHaveCount(0);
});

test("unsaved note changes can be discarded before switching enquiries", async ({ page, inbox }) => {
  inbox.rows.push({ ...sample, id: "44444444-4444-4444-8444-444444444444", reference: "ME-SYNTHETIC-002", draft: { ...sample.draft, destination: "Singapore" } });
  const detail = await open(page);
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("Draft note.");
  await detail.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(detail.getByLabel("Internal follow-up note", { exact: true })).toHaveValue("");
  if ((page.viewportSize()?.width ?? 1440) < 1280) await page.getByRole("button", { name: "Back to enquiries", exact: true }).click();
  await page.getByRole("button", { name: "Open enquiry ME-SYNTHETIC-002", exact: true }).click();
  await expect(page.getByRole("region", { name: "Enquiry ME-SYNTHETIC-002", exact: true })).toContainText("Singapore");
  expect(inbox.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
});

test("320px detail and long customer values wrap without horizontal scrolling", async ({ page, inbox }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  inbox.rows = [{ ...sample, contact: { ...sample.contact, email: "very.long.synthetic.customer.address.for.wrapping@example.test" }, draft: { ...sample.draft, destination: "A multi-country holiday across several destinations" } }];
  const detail = await open(page);
  await detail.getByLabel("Internal follow-up note", { exact: true }).fill("A mobile follow-up note.");
  await noOverflow(page);
  await expect(detail.getByRole("button", { name: "Save follow-up", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("enquiry-detail-320.png"), fullPage: true, animations: "disabled" });
});

test("live enquiries are the default and test requests require an explicit separate view", async ({ page, inbox }, info) => {
  inbox.rows.push({ ...sample, id: "55555555-5555-4555-8555-555555555555", reference: "ME-SYNTHETIC-TEST", environment: "test", draft: { ...sample.draft, destination: "Test destination" } });
  await page.goto("/enquiries");
  await expect(page.getByRole("button", { name: "Live enquiries", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: `Open enquiry ${sample.reference}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open enquiry ME-SYNTHETIC-TEST", exact: true })).toHaveCount(0);
  expect(inbox.calls[0].url.searchParams.get("environment")).toBe("live");
  await page.getByRole("button", { name: "Test enquiries", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Test enquiries only.");
  await expect(page.getByRole("button", { name: `Open enquiry ${sample.reference}`, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open enquiry ME-SYNTHETIC-TEST", exact: true }).click();
  const detail = page.getByRole("region", { name: "Enquiry ME-SYNTHETIC-TEST", exact: true });
  await expect(detail.getByText("Test", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: /create|book|pay|send/i })).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("test-enquiry-mode.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Live enquiries", exact: true }).click();
  await expect(page.getByRole("button", { name: `Open enquiry ${sample.reference}`, exact: true })).toBeVisible();
  await expect(page.getByText("Test enquiries only.", { exact: true })).toHaveCount(0);
  expect(inbox.calls.every(call => call.method === "GET")).toBe(true);
});
