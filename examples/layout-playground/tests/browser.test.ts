import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { resolve } from "node:path";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { HStack, Item } from "@mincho-js/react/layout";
import type * as Fixture from "./browser.fixture.js";

declare global {
  interface Window {
    LayoutFixture: typeof Fixture;
  }
}

async function openFixture(mode: "development" | "production") {
  const bundle = await build({
    entryPoints: [resolve(process.cwd(), "tests/browser.fixture.tsx")],
    bundle: true,
    jsx: "automatic",
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "LayoutFixture",
    define: { "process.env.NODE_ENV": JSON.stringify(mode) }
  });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  });
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return { browser, page };
}

describe.skipIf(process.env.MINCHO_LAYOUT_BROWSER !== "1")(
  "real browser layout",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      ({ browser, page } = await openFixture("development"));
    }, 30_000);
    afterAll(async () => {
      await browser?.close();
    });

    async function mount(name: string, strict = false) {
      await page.evaluate(
        ([n, s]) => window.LayoutFixture.mount(n as string, s as boolean),
        [name, strict]
      );
      await page
        .locator('[data-mincho-layout-state="valid"]')
        .first()
        .waitFor({ state: "attached" });
      expect(await page.evaluate(() => window.LayoutFixture.errors)).toEqual(
        []
      );
    }
    async function rect(id: string) {
      return (await page.locator(`#${id}`).boundingBox())!;
    }

    it.each([
      ["single-between", 0],
      ["single-around", 150],
      ["single-evenly", 150]
    ] as const)("%s handles a single item", async (name, offset) => {
      await mount(name);
      expect((await rect("a")).x - (await rect("stack")).x).toBe(offset);
    });

    it("T16/T22 redistributes remaining space after fixed bounds", async () => {
      await mount("bounded-center");
      expect((await rect("a")).x - (await rect("stack")).x).toBe(200);
      expect((await rect("b")).width).toBe(100);
      await mount("two-gaps");
      expect((await rect("b")).x - (await rect("a")).x).toBe(210);
      expect((await rect("d")).x - (await rect("c")).x).toBe(210);
      await mount("zero-gap");
      expect((await rect("b")).x - (await rect("a")).x).toBe(100);
    });

    it("does not re-render memoized children for decoration changes", async () => {
      await mount("memo");
      const before = await page.evaluate(() => window.LayoutFixture.renders());
      await page.evaluate(() => window.LayoutFixture.update());
      expect(await page.locator("#stack").getAttribute("class")).toBe("on");
      expect(await page.evaluate(() => window.LayoutFixture.renders())).toBe(
        before
      );
    });

    it.each(["maxWidth", "maxHeight"])(
      "updates %s before validating larger insets",
      async (bound) => {
        await mount(`grow-${bound}`);
        await page.evaluate(async () => {
          window.LayoutFixture.update();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        expect(await page.evaluate(() => window.LayoutFixture.errors)).toEqual(
          []
        );
        expect(
          await page.locator("#stack").getAttribute("data-mincho-layout-state")
        ).toBe("valid");
      }
    );

    it.each(["maxWidth", "maxHeight"])(
      "uses a reduced %s when later DOM styles change",
      async (bound) => {
        await mount(`shrink-${bound}`);
        await page.evaluate(() => window.LayoutFixture.update());
        await page.locator("#stack").evaluate((node) => {
          node.style.borderWidth = "30px";
        });
        await expect
          .poll(() => page.locator("#error").textContent())
          .toContain("E_INVALID_BOUNDS");
      }
    );

    it("keeps hugging nested stacks without shrink participants", async () => {
      await mount("nested-hug");
      expect((await rect("a")).width).toBe(120);
      expect((await rect("b")).x - (await rect("a")).x).toBe(132);
    });

    it("T21 excludes absolute children from a hugging Box", async () => {
      await page.evaluate(() => window.LayoutFixture.mount("absolute"));
      expect(await page.evaluate(() => window.LayoutFixture.errors)).toEqual(
        []
      );
      expect(await rect("box")).toMatchObject({ width: 0, height: 0 });
    });

    it.each([
      ["stretch-max", 100, 500],
      ["stretch-min", 250, 50],
      ["stretch-both", 800, 200],
      ["fractional", 200, 400]
    ] as const)("%s uses final-size ratios with bounds", async (name, a, b) => {
      await mount(name);
      expect((await rect("a")).width).toBeCloseTo(a, 1);
      expect((await rect("b")).width).toBeCloseTo(b, 1);
    });

    it("T01/T02 distinguishes distributed and exact boundary spacing", async () => {
      await mount("between");
      let a = await rect("a");
      let b = await rect("b");
      expect(b.x - a.x - a.width).toBe(200);
      await mount("center");
      a = await rect("a");
      b = await rect("b");
      expect(a.x - (await rect("stack")).x).toBe(90);
      expect(b.x - a.x - a.width).toBe(20);
    });

    it("auto spaces keep their gutter and overflowing center falls back to start", async () => {
      await mount("auto-gap");
      expect((await rect("b")).x - (await rect("a")).x).toBe(120);
      await mount("overflow");
      expect((await rect("a")).x).toBe((await rect("stack")).x);
      expect((await rect("b")).x - (await rect("a")).x).toBe(108);
    });

    it("T11/T18 wraps before shrinking and resolves percentages against content size", async () => {
      await mount("wrap");
      expect((await rect("a")).y).toBe((await rect("b")).y);
      expect((await rect("c")).y - (await rect("a")).y).toBe(32);
      await mount("percent");
      expect((await rect("a")).width).toBe(140);
    });

    it("T29/T30 uses logical margins in RTL and on the vertical axis", async () => {
      await mount("rtl");
      expect((await rect("a")).x - (await rect("b")).x).toBe(120);
      await mount("vertical");
      expect((await rect("b")).y - (await rect("a")).y).toBe(120);
    });

    it("renormalizes after null rendering, visibility and axis changes", async () => {
      await mount("dynamic", true);
      await page.evaluate(() => window.LayoutFixture.update());
      expect((await rect("b")).x - (await rect("stack")).x).toBe(20);
      await mount("hidden");
      await page
        .locator("#a")
        .evaluate((node) => ((node as HTMLElement).hidden = true));
      await expect
        .poll(async () => (await rect("b")).x - (await rect("stack")).x)
        .toBe(20);
      await mount("axis");
      await page.evaluate(() => window.LayoutFixture.update());
      expect((await rect("b")).y - (await rect("stack")).y).toBe(50);
      expect((await rect("b")).x).toBe((await rect("stack")).x);
    });

    it("custom as forwards events/refs without wrappers and cleans up on unmount", async () => {
      await mount("custom-as", true);
      expect(await page.locator("#stack > button").count()).toBe(2);
      await page.locator("#a").click();
      expect(await page.evaluate(() => window.LayoutFixture.events)).toEqual([
        "target",
        "item"
      ]);
      expect(
        await page.evaluate(() => window.LayoutFixture.externalRef.current?.id)
      ).toBe("a");
      expect(
        await page.evaluate(() => window.LayoutFixture.inspect())
      ).toMatchObject({
        path: "native",
        source: "browser",
        computedStyle: { "flex-direction": "row", width: "400px" }
      });
      await page.evaluate(() => window.LayoutFixture.unmount());
      expect(
        await page.evaluate(() => window.LayoutFixture.externalRef.current)
      ).toBeNull();
    });

    it.each([
      ["duplicate", "E_DUPLICATE_BOUNDARY_SPACE"],
      ["css-hidden", "E_UNSUPPORTED_DOM_CHILD"],
      ["wrong-parent", "E_INVALID_ITEM_PARENT"],
      ["text", "E_UNSUPPORTED_DOM_CHILD"],
      ["missing-ref", "E_INVALID_LAYOUT_ROOT"],
      ["imperative-root", "E_INVALID_LAYOUT_ROOT"],
      ["missing-style", "E_INVALID_LAYOUT_ROOT"],
      ["missing-variables", "E_INVALID_LAYOUT_ROOT"],
      ["multiple-shrink", "E_LAYOUT_CAPABILITY"],
      ["padded-stretch", "E_LAYOUT_CAPABILITY"],
      ["border-bounds", "E_INVALID_BOUNDS"],
      ["box-percentage", "E_PERCENT_DEPENDENCY"],
      ["cyclic-stretch", "E_LAYOUT_CAPABILITY"]
    ])("rejects %s", async (name, code) => {
      await page.evaluate((n) => window.LayoutFixture.mount(n), name);
      await expect
        .poll(() => page.locator("#error").textContent())
        .toContain(code);
    });

    it("hydrates pending native markup without hydration mismatches", async () => {
      const html = renderToString(
        h(
          HStack,
          { id: "stack", width: 400, gap: 12 },
          h(Item, { id: "a", width: 100, height: 20 }),
          h(Item, { id: "b", width: 100, height: 20, gapBefore: 20 })
        )
      );
      await page.evaluate((value) => window.LayoutFixture.hydrate(value), html);
      await page.locator('[data-mincho-layout-state="valid"]').waitFor();
      expect(await page.evaluate(() => window.LayoutFixture.errors)).toEqual(
        []
      );
      expect((await rect("b")).x - (await rect("a")).x).toBe(120);
    });
  }
);

describe.skipIf(process.env.MINCHO_LAYOUT_BROWSER !== "1")(
  "production browser layout",
  () => {
    let browser: Browser;
    let page: Page;
    const logged: string[] = [];
    beforeAll(async () => {
      ({ browser, page } = await openFixture("production"));
      page.on("console", (message) => {
        if (message.type() === "error") logged.push(message.text());
      });
    }, 30_000);
    afterAll(async () => {
      await browser?.close();
    });

    async function rect(id: string) {
      return (await page.locator(`#${id}`).boundingBox())!;
    }
    async function mount(name: string) {
      await page.evaluate((n) => window.LayoutFixture.mount(n), name);
      await page.locator("#stack").waitFor({ state: "attached" });
    }

    it("applies relations and follows conditional DOM changes", async () => {
      await mount("two-gaps");
      expect((await rect("b")).x - (await rect("a")).x).toBe(210);
      await mount("dynamic");
      await page.evaluate(() => window.LayoutFixture.update());
      await expect
        .poll(async () => (await rect("b")).x - (await rect("stack")).x)
        .toBe(20);
      await mount("hidden");
      await page
        .locator("#a")
        .evaluate((node) => ((node as HTMLElement).hidden = true));
      await expect
        .poll(async () => (await rect("b")).x - (await rect("stack")).x)
        .toBe(20);
    });

    it("renders custom as targets and forwards events/refs in production", async () => {
      await mount("custom-as");
      expect(await page.locator("#stack > button").count()).toBe(2);
      await page.locator("#a").click();
      expect(await page.evaluate(() => window.LayoutFixture.events)).toEqual([
        "target",
        "item"
      ]);
      expect(
        await page.evaluate(() => window.LayoutFixture.externalRef.current?.id)
      ).toBe("a");
      await page.evaluate(() => window.LayoutFixture.unmount());
      expect(
        await page.evaluate(() => window.LayoutFixture.externalRef.current)
      ).toBeNull();
    });

    it("renders without development state or diagnostics", async () => {
      logged.length = 0;
      await mount("multiple-shrink");
      expect(await page.locator("#error").count()).toBe(0);
      expect(await page.locator("[data-mincho-layout-state]").count()).toBe(0);
      expect(await page.evaluate(() => window.LayoutFixture.errors)).toEqual(
        []
      );
      expect(logged).toEqual([]);
    });

    it("installs CSS per document at commit without layout reads or observers", async () => {
      const result = await page.evaluate(() => {
        const computed = window.getComputedStyle;
        const resize = window.ResizeObserver;
        const mutation = window.MutationObserver;
        const counts = { reads: 0, observers: 0 };
        window.getComputedStyle = (...args) => {
          counts.reads++;
          return computed(...args);
        };
        window.ResizeObserver = class extends resize {
          constructor(callback: ResizeObserverCallback) {
            super(callback);
            counts.observers++;
          }
        };
        window.MutationObserver = class extends mutation {
          constructor(callback: MutationCallback) {
            super(callback);
            counts.observers++;
          }
        };
        try {
          window.LayoutFixture.mount("nested-hug");
          const iframe = document.createElement("iframe");
          document.body.append(iframe);
          window.LayoutFixture.mount("between", false, iframe.contentDocument!);
          const doc = iframe.contentDocument!;
          const sheetCount = doc.querySelectorAll(
            "[data-mincho-layout-sheet]"
          ).length;
          const a = doc.getElementById("a")!.getBoundingClientRect();
          const b = doc.getElementById("b")!.getBoundingClientRect();
          window.LayoutFixture.unmount();
          iframe.remove();
          return { ...counts, sheetCount, gap: b.x - a.x - a.width };
        } finally {
          window.getComputedStyle = computed;
          window.ResizeObserver = resize;
          window.MutationObserver = mutation;
        }
      });
      expect(result).toEqual({
        reads: 0,
        observers: 0,
        sheetCount: 1,
        gap: 200
      });
    });

    it.each(["invalid-nan", "invalid-infinity"])(
      "validates %s after an undefined bound",
      async (name) => {
        await mount(name);
        await page.evaluate(() => window.LayoutFixture.update());
        await expect
          .poll(() => page.locator("#error").textContent())
          .toContain("E_INVALID_NUMBER");
      }
    );
  }
);

describe.skipIf(process.env.MINCHO_LAYOUT_BROWSER !== "1").each([
  { profile: "development", minify: false },
  { profile: "production", minify: false },
  { profile: "production", minify: true }
] as const)(
  "compiled layout JSX ($profile, minify=$minify)",
  ({ profile, minify }) => {
    let browser: Browser;
    const pages: Record<"runtime" | "compiled", Page> = {} as never;
    const sources: Record<"runtime" | "compiled", string> = {} as never;
    const pageErrors: string[] = [];
    beforeAll(async () => {
      const { minchoEsbuildPlugins } = await import("@mincho-js/esbuild");
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      });
      for (const mode of ["runtime", "compiled"] as const) {
        const result = await build({
          entryPoints: [resolve(process.cwd(), "tests/compiled.fixture.tsx")],
          bundle: true,
          minify,
          jsx: "automatic",
          write: false,
          outdir: resolve(process.cwd(), ".cache/compiled-fixture", mode),
          platform: "browser",
          format: "iife",
          globalName: "CompiledFixture",
          define: { "process.env.NODE_ENV": JSON.stringify(profile) },
          plugins: minchoEsbuildPlugins({
            optimizationMode: profile,
            optimize: { styledComponents: mode === "compiled" }
          })
        });
        const js = result.outputFiles.find((file) =>
          file.path.endsWith(".js")
        )!;
        const css = result.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join("\n");
        sources[mode] = js.text;
        const page = await browser.newPage();
        page.on("pageerror", (error) =>
          pageErrors.push(`${mode}: ${error.message}`)
        );
        // The runtime build adds the stylesheet on the client instead.
        if (css.trim()) await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: js.text });
        await page.evaluate(() =>
          (
            window as unknown as { CompiledFixture: { mount(): void } }
          ).CompiledFixture.mount()
        );
        pages[mode] = page;
      }
    }, 120_000);
    afterAll(async () => {
      await browser?.close();
    });

    const rects = (page: Page) =>
      page.evaluate(() =>
        Object.fromEntries(
          Array.from(document.querySelectorAll("[id]"), (node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return [node.id, { x, y, width, height }];
          })
        )
      );

    it("lowers static elements and keeps runtime ones", async () => {
      expect(pageErrors).toEqual([]);
      expect(sources.runtime).toContain("data-mincho-layout-axis");
      const inline = (mode: "runtime" | "compiled", id: string) =>
        pages[mode].locator(`#${id}`).getAttribute("style");
      expect(await inline("runtime", "toolbar")).toContain("--mincho-layout");
      expect(await inline("compiled", "toolbar")).toBeNull();
      expect(await inline("compiled", "toolbar-c")).toBeNull();
      expect(await inline("compiled", "component-stretch-b")).toBeNull();
      expect(await inline("compiled", "component-boundary-b")).toBeNull();
      if (profile === "production") {
        if (minify)
          expect(sources.compiled).not.toContain("data-mincho-layout-static");
        expect(
          await pages.compiled.locator("[data-mincho-layout-static]").count()
        ).toBe(0);
      } else {
        expect(
          await pages.compiled
            .locator("#component-stretch-b")
            .getAttribute("data-mincho-layout-static")
        ).toBe(JSON.stringify({ width: "stretch", height: 20 }));
      }
      // Runtime descendants keep their Stack provider, including development overrides.
      expect(await inline("compiled", "mixed")).toContain("--mincho-layout");
      expect(await inline("compiled", "mixed-a")).toContain("--mincho-layout");
      for (const id of ["mixed-b", "mixed-stretch-a", "mixed-stretch-b"])
        expect(await inline("compiled", id)).toContain("--mincho-layout");
      // Box and Item provide null contexts beneath a runtime Stack.
      for (const id of ["parent-box", "parent-item"])
        expect(await inline("compiled", id)).toContain("--mincho-layout");
      expect(await inline("compiled", "as-native")).toContain(
        "--mincho-layout"
      );
      expect(await inline("compiled", "as-custom")).toContain(
        "--mincho-layout"
      );
      expect(await pages.compiled.locator("#as-targets > button").count()).toBe(
        2
      );

      const classes = await pages.compiled
        .locator("#repeated > *")
        .evaluateAll((nodes) => nodes.map((node) => node.className));
      expect(new Set(classes).size).toBe(1);
    });

    it("matches runtime geometry, including after conditional rendering", async () => {
      expect(pageErrors).toEqual([]);
      const runtime = await rects(pages.runtime);
      expect(runtime["patterns-a"].width).toBeCloseTo(200, 1);
      expect(runtime["patterns-b"].width).toBeCloseTo(400, 1);
      expect(runtime["box-child"].width).toBe(72);
      expect(runtime["item-child"].width).toBe(72);
      expect(runtime["mixed-stretch-a"].width).toBe(190);
      expect(runtime["mixed-stretch-b"].width).toBe(190);
      expect(runtime["component-stretch-a"].width).toBe(190);
      expect(runtime["component-stretch-b"].width).toBe(190);
      expect(
        runtime["component-boundary-b"].x - runtime["component-boundary-a"].x
      ).toBe(140);
      expect(runtime["edge-before-a"].x - runtime["edge-before"].x).toBe(232);
      expect(runtime["edge-after-a"].x - runtime["edge-after"].x).toBe(0);
      expect(runtime["edge-rtl-a"].x - runtime["edge-rtl"].x).toBe(88);
      expect(runtime["edge-vertical-a"].y - runtime["edge-vertical"].y).toBe(
        232
      );
      expect(Object.keys(runtime).length).toBeGreaterThan(30);
      expect(await rects(pages.compiled)).toEqual(runtime);
      for (const page of Object.values(pages))
        await page.evaluate(() =>
          (
            window as unknown as { CompiledFixture: { update(): void } }
          ).CompiledFixture.update()
        );
      const toggled = await rects(pages.runtime);
      expect(toggled["conditional-b"].x - toggled.conditional.x).toBe(20);
      expect(
        toggled["component-boundary-b"].x - toggled["component-boundary-a"].x
      ).toBe(120);
      expect(await rects(pages.compiled)).toEqual(toggled);
      expect(pageErrors).toEqual([]);
    });
  }
);
