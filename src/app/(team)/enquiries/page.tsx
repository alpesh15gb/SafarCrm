import { requireTeam } from "@/lib/auth";
import WebsiteEnquiries from "@/components/website-enquiries";

export const metadata = { title: "Website enquiries", robots: { index: false, follow: false } };

export default async function EnquiriesPage() {
  const me = await requireTeam();
  return <WebsiteEnquiries key={me.id} />;
}
