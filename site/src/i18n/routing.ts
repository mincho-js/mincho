import { basePath, siteOrigin } from "../../site.config.mjs";

export const locales = ["en", "ko"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Next.js pathname values exclude the deployment's basePath. */
export function localizedPath(pathname: string, locale: Locale): string {
  const path = pathname.replace(/^\/ko(?=\/|$)/, "") || "/";
  return locale === defaultLocale ? path : `/ko${path === "/" ? "" : path}`;
}

export function languageAlternates(pathname: string) {
  return {
    languages: {
      en: `${siteOrigin}${basePath}${localizedPath(pathname, "en")}`,
      ko: `${siteOrigin}${basePath}${localizedPath(pathname, "ko")}`,
      "x-default": `${siteOrigin}${basePath}${localizedPath(pathname, defaultLocale)}`
    }
  };
}
