import { setupI18n } from "@lingui/core";
import { messages as en } from "../locales/en/messages.mjs";
import { messages as ko } from "../locales/ko/messages.mjs";
import type { Locale } from "./routing";

const catalogs = { en, ko };

// Each render gets its own instance: concurrent static renders cannot change
// another page's language through Lingui's global singleton.
export function getI18n(locale: Locale) {
  return setupI18n({ locale, messages: { [locale]: catalogs[locale] } });
}
