import { loadStylesheets } from "./css-loading.js";
import {
  resolveSsrStylesheets,
  type MinchoSsrCssManifest,
  type MinchoSsrCssOptions
} from "./ssr.js";
import {
  resolveThemePreference,
  type MinchoThemeSnapshot
} from "./themeTypes.js";

export type {
  MinchoThemeSnapshot,
  MinchoThemeRegistry,
  MinchoThemeSelector
} from "./themeTypes.js";
export interface MinchoThemePersistence {
  read(): string | null | undefined;
  write(preference: string): void;
}
export interface MinchoThemeControllerOptions extends MinchoSsrCssOptions {
  document?: Document;
  target?: Element;
  initial?: MinchoThemeSnapshot;
  preference?: string;
  persistence?: false | MinchoThemePersistence;
  timeoutMs?: number;
}

/** Optional client entry. Persistence is opt-in; loaded styles are shared across controllers. */
export function createThemeController(
  manifest: MinchoSsrCssManifest,
  options: MinchoThemeControllerOptions = {}
) {
  if (manifest.version !== 2 || !manifest.themes)
    throw new Error("Theme controller requires a Mincho v2 theme manifest.");
  const registry = manifest.themes;
  const doc = options.document ?? globalThis.document;
  const target = options.target ?? doc?.documentElement;
  if (!doc || !target || target.ownerDocument !== doc)
    throw new Error("Theme controller requires a target in its document.");
  const media = registry.system
    ? doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")
    : undefined;
  const scheme = () =>
    media
      ? media.matches
        ? ("dark" as const)
        : ("light" as const)
      : undefined;
  let stored: string | null | undefined;
  if (!options.initial && !options.preference && options.persistence) {
    try {
      stored = options.persistence.read();
    } catch {
      /* Storage is an optional convenience. */
    }
  }
  if (stored && stored !== "system" && !Object.hasOwn(registry.entries, stored))
    stored = undefined;
  if (stored === "system" && !registry.system) stored = undefined;
  const preference =
    options.initial?.preference ??
    options.preference ??
    stored ??
    registry.default;
  let snapshot: MinchoThemeSnapshot = options.initial
    ? { ...options.initial }
    : {
        preference,
        resolved: resolveThemePreference(registry, preference),
        status: "loading"
      };
  resolveThemePreference(registry, snapshot.preference);
  if (!Object.hasOwn(registry.entries, snapshot.resolved))
    throw new Error("Invalid resolved theme in the initial snapshot.");
  snapshot = Object.freeze(snapshot);
  let requested = preference;
  let serial = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (value: MinchoThemeSnapshot) => {
    snapshot = Object.freeze(value);
    for (const listener of listeners) listener();
  };
  const ensureActive = () => {
    if (disposed) throw new Error("Theme controller has been disposed.");
  };
  const preloadTheme = async (value: string) => {
    ensureActive();
    const id = resolveThemePreference(registry, value, scheme());
    await loadStylesheets(
      resolveSsrStylesheets(manifest, { themes: [id] }, options),
      { document: doc, timeoutMs: options.timeoutMs }
    );
  };
  const apply = (id: string) => {
    const selected = registry.entries[id]!.selector;
    for (const theme of Object.values(registry.entries)) {
      if ("className" in theme.selector)
        target.classList.remove(theme.selector.className);
      else if (
        target.getAttribute(theme.selector.attribute) === theme.selector.value
      )
        target.removeAttribute(theme.selector.attribute);
    }
    if ("className" in selected) target.classList.add(selected.className);
    else target.setAttribute(selected.attribute, selected.value);
  };
  const setTheme = async (value: string): Promise<MinchoThemeSnapshot> => {
    ensureActive();
    const resolved = resolveThemePreference(registry, value, scheme());
    const request = ++serial;
    requested = value;
    publish({ ...snapshot, status: "loading", error: undefined });
    try {
      await preloadTheme(resolved);
      if (disposed || request !== serial) return snapshot;
      apply(resolved);
      publish({ preference: value, resolved, status: "ready" });
      if (options.persistence) {
        try {
          options.persistence.write(value);
        } catch {
          /* Keep the applied theme. */
        }
      }
      return snapshot;
    } catch (error) {
      if (!disposed && request === serial) {
        requested = snapshot.preference;
        publish({ ...snapshot, status: "error", error });
      }
      throw error;
    }
  };
  const onSystemChange = () => {
    if (requested === "system") void setTheme("system").catch(() => {});
  };
  media?.addEventListener("change", onSystemChange);
  const ready = Promise.resolve().then(() =>
    serial || disposed ? snapshot : setTheme(preference)
  );
  // Initialization errors remain observable via ready and the snapshot.
  void ready.catch(() => {});
  return {
    ready,
    setTheme,
    preloadTheme,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      ensureActive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      serial++;
      media?.removeEventListener("change", onSystemChange);
      listeners.clear();
    }
  };
}
