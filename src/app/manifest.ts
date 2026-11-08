import type { MetadataRoute } from "next";

/** Lets the boss install the CRM as an app (Safari ▸ File ▸ Add to Dock, or Chrome ▸ Install). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Safar CRM",
    short_name: "Safar",
    description: "Travel CRM for the agency team",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f7f8fa",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
