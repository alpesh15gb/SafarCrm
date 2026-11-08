import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";
import { Toaster } from "@/components/client";

export const metadata: Metadata = {
  title: { default: "Safar CRM", template: "%s · Safar CRM" },
  description: "Travel CRM",
  appleWebApp: { capable: true, title: "Safar CRM", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f7f8fa" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
