import { redirect } from "next/navigation";
import { getMe } from "@/lib/auth";

export default async function Home() {
  const me = await getMe();
  if (!me) redirect("/login");
  redirect(me.role === "client" ? "/portal" : "/dashboard");
}
