import { redirect } from "next/navigation";
import { getMe } from "@/lib/auth";
import { SetPasswordForm } from "./form";

export const metadata = { title: "Set your password" };

export default async function SetPasswordPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-[10px] border border-line bg-white p-5 shadow-soft">
        <h1 className="text-lg font-semibold">Welcome, {me.full_name}</h1>
        <p className="mb-4 text-[13px] text-muted">Please choose your own password to continue.</p>
        <SetPasswordForm />
      </div>
    </main>
  );
}
