"use client";

import { useLingui } from "@lingui/react";
import { usePathname, useRouter } from "next/navigation";
import { localizedPath, type Locale } from "../i18n/routing";

export function LanguageSwitcher() {
  const { i18n } = useLingui();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <select
      className="mincho-language-switcher"
      aria-label={i18n._({ id: "language.select", message: "Select language" })}
      value={i18n.locale}
      onChange={(event) => {
        const path = localizedPath(pathname, event.target.value as Locale);
        router.push(`${path}${window.location.search}${window.location.hash}`);
      }}
    >
      <option value="en" lang="en">
        English
      </option>
      <option value="ko" lang="ko">
        한국어
      </option>
    </select>
  );
}
