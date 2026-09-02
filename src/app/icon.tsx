import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * Generated rather than a static file, so the mark drawn here can never
 * silently drift from Brandmark in components/brand.tsx - same initials,
 * same accent colour family. ImageResponse renders outside any stylesheet, so
 * the colour is a literal matching --accent in globals.css rather than a CSS
 * variable reference, which Satori cannot resolve.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#4F46E5",
          borderRadius: 7,
          color: "white",
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "-0.02em",
        }}
      >
        NG
      </div>
    ),
    { ...size },
  );
}
