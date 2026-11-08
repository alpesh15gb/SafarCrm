import { requireTeam } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ProfileClient } from "./client";

export const metadata = { title: "My profile" };

export default async function ProfilePage() {
  const me = await requireTeam();
  return (
    <>
      <PageHeader title="My profile and security" sub={`${me.full_name} · ${me.email} · ${me.role === "boss" ? "Boss (admin)" : "Staff"}`} />
      <ProfileClient isBoss={me.role === "boss"} />
    </>
  );
}
