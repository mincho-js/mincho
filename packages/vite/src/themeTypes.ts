export type MinchoThemeSelector =
  { className: string } | { attribute: string; value: string };
export interface MinchoThemeRegistry {
  default: string;
  system?: { light: string; dark: string };
  entries: Readonly<
    Record<string, { css: readonly string[]; selector: MinchoThemeSelector }>
  >;
}
export interface MinchoThemeSnapshot {
  preference: string;
  resolved: string;
  status: "ready" | "loading" | "error";
  error?: unknown;
}

export function resolveThemePreference(
  registry: MinchoThemeRegistry,
  preference: string,
  scheme?: "light" | "dark"
) {
  if (preference === "system") {
    if (!registry.system)
      throw new Error("System theme mapping is not configured.");
    return scheme ? registry.system[scheme] : registry.default;
  }
  if (!Object.hasOwn(registry.entries, preference))
    throw new Error(`Unknown Mincho theme: ${preference}`);
  return preference;
}
