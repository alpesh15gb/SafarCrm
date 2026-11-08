import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Dock / home-screen icon (Safari "Add to Dock" on macOS, "Add to Home Screen" on iPhone). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #ff8a7a, #e14f4f)" }}>
        <svg width="112" height="112" viewBox="0 0 64 64">
          <path d="M45 20 19 31.5l9.5 3.2L31 44l4.5-6.8L45 20Z" fill="#fff" />
          <path d="m28.5 34.7 16.5-14.7-11.6 17.2" fill="#ffe1dc" />
        </svg>
      </div>
    ),
    size,
  );
}
