"use client";

import { setupI18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useMemo, type ReactNode } from "react";
import type { Locale } from "../i18n/routing";

export function LinguiProvider({
  locale,
  messages,
  children
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const i18n = useMemo(
    () => setupI18n({ locale, messages: { [locale]: messages } }),
    [locale, messages]
  );

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
