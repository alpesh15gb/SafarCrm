import { createRoot } from "react-dom/client";
import WebsiteEnquiries from "../../src/components/website-enquiries";

// Only the real client component is mounted. No auth, database or native CRM
// mutations are initialized by this synthetic UI fixture.
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-[1440px] px-4 py-6 md:px-8"><WebsiteEnquiries /></main>);
