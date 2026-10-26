import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThemeController } from "./themes.js";
import {
  resolveSsrTheme,
  resolveSsrStylesheets,
  type MinchoSsrCssManifest
} from "./ssr.js";

const load = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("./css-loading.js", () => ({ loadStylesheets: load }));

const manifest: MinchoSsrCssManifest = {
  version: 2,
  base: "/app/",
  entries: { "index.html": ["base.css"] },
  routes: {},
  modules: {},
  themes: {
    default: "light",
    system: { light: "light", dark: "dark" },
    entries: {
      light: { css: ["light.css"], selector: { className: "themeLight" } },
      dark: { css: ["dark.css"], selector: { className: "themeDark" } },
      contrast: {
        css: ["contrast.css"],
        selector: { attribute: "data-theme", value: "contrast" }
      }
    }
  }
};
function documentFixture() {
  const classes = new Set(["appRoot"]);
  const attrs = new Map([["data-other", "keep"]]);
  const changes = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_: string, callback: () => void) =>
      changes.add(callback),
    removeEventListener: (_: string, callback: () => void) =>
      changes.delete(callback)
  };
  const root = {
    ownerDocument: undefined as unknown,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name)
    },
    getAttribute: (name: string) => attrs.get(name),
    removeAttribute: (name: string) => attrs.delete(name),
    setAttribute: (name: string, value: string) => attrs.set(name, value)
  };
  const document = {
    documentElement: root,
    defaultView: { matchMedia: () => media }
  };
  root.ownerDocument = document;
  return {
    document: document as unknown as Document,
    classes,
    attrs,
    media,
    changes
  };
}
const deferred = () => {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  load.mockReset();
  load.mockResolvedValue();
});

describe("explicit lazy themes", () => {
  it("resolves SSR CSS, managed attributes and the hydration snapshot together", () => {
    const result = resolveSsrTheme(manifest, {
      preference: "system",
      systemScheme: "dark",
      selection: { entries: ["index.html"] }
    });
    expect(result.attributes).toEqual({ class: "themeDark" });
    expect(result.snapshot).toEqual({
      preference: "system",
      resolved: "dark",
      status: "ready"
    });
    expect(result.stylesheets.map((link) => link.href)).toEqual([
      "/app/base.css",
      "/app/dark.css"
    ]);
    expect(
      resolveSsrTheme(manifest, { preference: "system" }).snapshot.resolved
    ).toBe("light");
    expect(
      resolveSsrStylesheets(
        {
          version: 1,
          base: "/",
          entries: { app: ["a.css"] },
          routes: {},
          modules: {}
        },
        { entries: ["app"] }
      )
    ).toHaveLength(1);
  });
  it("loads before DOM commit, honors the latest request and retains the previous theme on failure", async () => {
    const dom = documentFixture();
    const controller = createThemeController(manifest, dom);
    await controller.ready;
    const dark = deferred(),
      contrast = deferred();
    load
      .mockImplementationOnce(() => dark.promise)
      .mockImplementationOnce(() => contrast.promise);
    const first = controller.setTheme("dark");
    const second = controller.setTheme("contrast");
    expect(dom.classes.has("themeLight")).toBe(true);
    contrast.resolve();
    await second;
    dark.resolve();
    await first;
    expect(controller.getSnapshot().resolved).toBe("contrast");
    expect(dom.classes).toEqual(new Set(["appRoot"]));
    expect(dom.attrs.get("data-theme")).toBe("contrast");
    expect(dom.attrs.get("data-other")).toBe("keep");
    load.mockRejectedValueOnce(new Error("network"));
    await expect(controller.setTheme("dark")).rejects.toThrow("network");
    expect(controller.getSnapshot()).toMatchObject({
      resolved: "contrast",
      status: "error"
    });
    expect(dom.attrs.get("data-theme")).toBe("contrast");
    controller.dispose();
  });
  it("keeps the SSR snapshot first and follows OS changes only for system preference", async () => {
    const dom = documentFixture();
    const initial = resolveSsrTheme(manifest, {
      preference: "system",
      systemScheme: "light"
    }).snapshot;
    const controller = createThemeController(manifest, { ...dom, initial });
    expect(controller.getSnapshot()).toEqual(initial);
    await controller.ready;
    dom.media.matches = true;
    for (const callback of dom.changes) callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().resolved).toBe("dark");
    await controller.setTheme("light");
    for (const callback of dom.changes) callback();
    await Promise.resolve();
    expect(controller.getSnapshot().resolved).toBe("light");
    const count = load.mock.calls.length;
    controller.dispose();
    expect(dom.changes.size).toBe(0);
    expect(dom.classes.has("themeLight")).toBe(true);
    await expect(controller.setTheme("dark")).rejects.toThrow("disposed");
    expect(load).toHaveBeenCalledTimes(count);
  });
  it("uses only an explicit persistence adapter, tolerates storage failures and preloads without committing", async () => {
    const dom = documentFixture();
    const adapter = { read: vi.fn(() => "dark"), write: vi.fn() };
    const controller = createThemeController(manifest, {
      ...dom,
      persistence: adapter
    });
    await controller.ready;
    expect(controller.getSnapshot().resolved).toBe("dark");
    expect(adapter.write).toHaveBeenCalledWith("dark");
    await controller.preloadTheme("contrast");
    expect(controller.getSnapshot().resolved).toBe("dark");
    controller.dispose();
    const failed = createThemeController(manifest, {
      ...dom,
      persistence: {
        read() {
          throw new Error("denied");
        },
        write() {
          throw new Error("denied");
        }
      }
    });
    await expect(failed.ready).resolves.toMatchObject({ resolved: "light" });
    failed.dispose();
  });
});
