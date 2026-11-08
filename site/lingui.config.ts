import { defineConfig } from "@lingui/conf";

export default defineConfig({
  locales: ["en", "ko"],
  sourceLocale: "en",
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["<rootDir>/src/components"]
    }
  ],
  compileNamespace: "es"
});
