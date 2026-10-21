import { describe, expect, it } from "vitest";
import {
  createSsrCssCollector,
  resolveSsrStylesheets,
  type MinchoSsrCssManifest
} from "./ssr.js";

const manifest: MinchoSsrCssManifest = {
  version: 1,
  base: "/app/",
  entries: { "index.html": ["base.css"], "admin.html": ["admin.css"] },
  modules: { "extra.tsx": ["shared.css", "extra.css"] },
  routes: { a: ["shared.css", "a.css"], b: ["shared.css", "b.css"] }
};

const hrefs = (links: ReturnType<typeof resolveSsrStylesheets>) =>
  links.map((link) => link.href);

describe("SSR CSS request state", () => {
  it("preserves entry/dependency order and excludes unselected pages/routes", () => {
    expect(
      hrefs(
        resolveSsrStylesheets(manifest, {
          entries: ["index.html"],
          routes: ["a"]
        })
      )
    ).toEqual(["/app/base.css", "/app/shared.css", "/app/a.css"]);
  });

  it("separates discovery from response emission and isolates concurrent documents", () => {
    const first = createSsrCssCollector(manifest),
      second = createSsrCssCollector(manifest);

    first.collect({ routes: ["a"] });
    first.collect({ routes: ["a"] });

    expect(hrefs(first.flush())).toEqual(["/app/shared.css", "/app/a.css"]);

    first.collect({ routes: ["b"], modules: ["extra.tsx"] });

    expect(hrefs(first.flush())).toEqual(["/app/b.css", "/app/extra.css"]);
    expect(first.flush()).toEqual([]);

    second.collect({ routes: ["a"] });

    expect(hrefs(second.flush())).toEqual(["/app/shared.css", "/app/a.css"]);
  });

  it("does not partly acknowledge a failed selection or accept prototype keys", () => {
    const request = createSsrCssCollector(manifest);

    expect(() => request.collect({ routes: ["a", "missing"] })).toThrow(
      "Unknown"
    );
    expect(request.flush()).toEqual([]);
    expect(() => request.collect({ routes: ["__proto__"] })).toThrow("Unknown");
    expect(() => request.collect({ modules: ["toString"] })).toThrow("Unknown");
  });

  it("resolves relative bases like the client URL helper, retaining URL identity", () => {
    const relative = {
      ...manifest,
      base: "./",
      routes: { a: ["assets/a b.css?theme=dark"] }
    };

    expect(() => resolveSsrStylesheets(relative, { routes: ["a"] })).toThrow(
      "assetBaseUrl"
    );
    expect(
      hrefs(
        resolveSsrStylesheets(
          relative,
          { routes: ["a"] },
          { assetBaseUrl: "https://example.test/app/" }
        )
      )
    ).toEqual(["https://example.test/app/assets/a%20b.css?theme=dark"]);
    expect(
      hrefs(
        resolveSsrStylesheets(
          { ...manifest, base: "https://cdn.test/app/" },
          { routes: ["a"] }
        )
      )
    ).toEqual([
      "https://cdn.test/app/shared.css",
      "https://cdn.test/app/a.css"
    ]);
  });

  it("resolves nested MPA pages from the output root and rejects document URLs", () => {
    const relative = {
      ...manifest,
      base: "",
      entries: { "admin/settings/index.html": ["assets/settings.css"] }
    };

    const selection = { entries: ["admin/settings/index.html"] };

    expect(
      hrefs(
        resolveSsrStylesheets(relative, selection, {
          assetBaseUrl: "https://example.test/app/"
        })
      )
    ).toEqual(["https://example.test/app/assets/settings.css"]);

    for (const assetBaseUrl of [
      "https://example.test/app/admin/settings/index.html",
      "https://example.test/app/?theme=dark",
      "https://example.test/app/#root",
      "file:///app/"
    ])
      expect(() =>
        resolveSsrStylesheets(relative, selection, { assetBaseUrl })
      ).toThrow("HTTP(S) directory URL");
  });
});
