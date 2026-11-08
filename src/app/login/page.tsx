import { Plane, ShieldCheck, Bell, BarChart3 } from "lucide-react";
import { LoginForm } from "./form";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string; mfa?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* brand panel */}
      <section className="relative hidden overflow-hidden bg-navy p-12 text-white lg:flex lg:flex-col">
        <div className="bg-dots absolute inset-0 opacity-50" />
        <div className="absolute -left-24 top-1/3 h-96 w-96 rounded-full bg-coral/30 blur-3xl" />
        <div className="absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-linear-to-br from-[#ff9a85] to-coral-dark shadow-[0_6px_20px_-4px_rgba(250,112,112,0.6)]">
            <Plane className="h-5 w-5 -rotate-12" />
          </span>
          <span className="text-lg font-semibold tracking-[-0.01em]">Safar CRM</span>
        </div>

        <div className="relative my-auto max-w-md">
          <svg viewBox="0 0 360 120" className="mb-8 w-full text-white/25" fill="none" aria-hidden>
            <path d="M10 100C80 96 110 20 190 26s110 60 160-14" stroke="currentColor" strokeWidth="2" strokeDasharray="6 8" strokeLinecap="round" />
            <circle cx="10" cy="100" r="6" fill="#fa7070" />
            <circle cx="190" cy="26" r="4" fill="currentColor" />
            <path d="m338 4 18 5-12 14-2-8-8-3 4-8Z" fill="#fff" />
          </svg>
          <h1 className="text-[34px] font-semibold leading-[1.15] tracking-[-0.03em]">Every trip, every ticket, every rupee. In one place.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-400">Bookings, payments, documents and reminders for your whole team, with a portal your clients will love.</p>
          <ul className="mt-8 grid gap-3 text-sm text-slate-300">
            {[
              { I: BarChart3, t: "Live profit and dues at a glance" },
              { I: Bell, t: "Reminders for passports, payments and departures" },
              { I: ShieldCheck, t: "Encrypted IDs and private client documents" },
            ].map(({ I, t }) => (
              <li key={t} className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.07] ring-1 ring-inset ring-white/10"><I className="h-4 w-4 text-coral" /></span>{t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">Made for Indian travel agencies · ₹ · IST · April–March FY</p>
      </section>

      {/* form */}
      <section className="flex items-center justify-center p-6">
        <div className="animate-fade-up w-full max-w-[380px]">
          <div className="mb-8">
            <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-linear-to-br from-[#ff9a85] to-coral-dark text-white shadow-[0_6px_20px_-4px_rgba(250,112,112,0.6)] lg:hidden">
              <Plane className="h-5 w-5 -rotate-12" />
            </span>
            <h2 className="text-[26px] font-semibold tracking-[-0.025em]">Welcome back</h2>
            <p className="mt-1 text-sm text-muted">Staff log in with email. Clients log in with their mobile number.</p>
          </div>
          {sp.e === "inactive" && <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">This login is not active. Please contact the office.</p>}
          <LoginForm mfa={sp.mfa === "1"} />
          <p className="mt-8 text-center text-xs text-muted">Trouble logging in? Ask your agency owner to reset your password.</p>
        </div>
      </section>
    </main>
  );
}
