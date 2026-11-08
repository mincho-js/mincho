import Link from "next/link";
import { getI18n } from "../i18n/server";
import { localizedPath, type Locale } from "../i18n/routing";

export function HomePage({ locale }: { locale: Locale }) {
  const i18n = getI18n(locale);
  return (
    <div style={{ textAlign: "center", padding: "100px 20px" }}>
      <h1 style={{ fontSize: 48, fontWeight: "bold", marginBottom: 16 }}>
        Mincho.js
      </h1>
      <p style={{ fontSize: 20, color: "#666", marginBottom: 32 }}>
        {i18n._({ id: "home.tagline", message: "Natural CSS in TypeScript" })}
      </p>
      <Link
        href={localizedPath("/docs", locale)}
        style={{
          display: "inline-block",
          padding: "12px 24px",
          backgroundColor: "#0070f3",
          color: "white",
          borderRadius: 8,
          textDecoration: "none",
          fontWeight: 500
        }}
      >
        {i18n._({ id: "home.getStarted", message: "Get Started" })}
      </Link>
    </div>
  );
}
