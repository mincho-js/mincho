import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";
import type { Browser, Page } from "playwright";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SquircleMask } from "@mincho-js/react/squircle";
import type * as Fixture from "./squircle.fixture.js";

declare global {
  interface Window {
    SquircleFixture: typeof Fixture;
  }
}

describe
  .skipIf(process.env.MINCHO_LAYOUT_BROWSER !== "1")
  .each(["development", "production"])(
  "squircle browser contract (%s)",
  (mode) => {
    let browser: Browser;
    let page: Page;
    const pageErrors: string[] = [];
    beforeAll(async () => {
      const result = await build({
        entryPoints: [resolve(process.cwd(), "tests/squircle.fixture.tsx")],
        bundle: true,
        jsx: "automatic",
        write: false,
        platform: "browser",
        format: "iife",
        globalName: "SquircleFixture",
        define: { "process.env.NODE_ENV": JSON.stringify(mode) }
      });
      const engine = process.env.PLAYWRIGHT_BROWSER ?? "chromium";
      if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
        throw new Error(`Unsupported browser: ${engine}`);
      browser = await { chromium, firefox, webkit }[engine].launch({
        executablePath:
          process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
          (engine === "chromium"
            ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
            : undefined)
      });
      page = await browser.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addScriptTag({ content: result.outputFiles[0].text });
    }, 30_000);
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      expect(pageErrors).toEqual([]);
    });
    beforeEach(async () => {
      pageErrors.length = 0;
      await page.evaluate(() => {
        window.SquircleFixture.unmount();
        window.SquircleFixture.observation(true);
      });
    });
    const image = () =>
      page
        .locator("#mask")
        .evaluate((node) => getComputedStyle(node).maskImage);
    async function masked() {
      await expect.poll(image).toMatch(/#mincho-squircle-/);
    }
    const geometry = () =>
      page.locator("#mask").evaluate((node) => {
        const id = /#([^")]+)/.exec(getComputedStyle(node).maskImage)?.[1];
        const mask = (
          node.getRootNode() as Document | ShadowRoot
        ).getElementById(id ?? "");
        return mask
          ? {
              width: Number(mask.getAttribute("width")),
              height: Number(mask.getAttribute("height")),
              path: mask.querySelector("path")?.getAttribute("d")
            }
          : null;
      });
    async function pixel(x: number, y: number) {
      const shot = await page.screenshot({
        clip: { x, y, width: 1, height: 1 }
      });
      return page.evaluate(
        async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        },
        `data:image/png;base64,${shot.toString("base64")}`
      );
    }
    const snapshot = () =>
      page.evaluate(() => window.SquircleFixture.snapshot());

    it("renders fixed masks without observers or computed-style reads", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ width: 240, height: 140, radius: 24 })
      );
      expect(await snapshot()).toMatchObject({
        created: [],
        active: 0,
        reads: 0
      });
      await masked();
      expect(await page.locator("#mask").boundingBox()).toMatchObject({
        width: 240,
        height: 140
      });
      expect(pageErrors).toEqual([]);
    });

    it("measures border boxes and resizes without rerendering children or losing focus", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 24,
          style: {
            width: 240,
            height: 140,
            padding: 10,
            border: "2px solid black"
          }
        })
      );
      await masked();
      expect(await geometry()).toMatchObject({ width: 240, height: 140 });
      await page.locator("#input").fill("edited");
      const previous = await snapshot();
      await page.locator("#mask").evaluate((node) => {
        node.style.width = "320.5px";
      });
      await expect.poll(geometry).toMatchObject({ width: 320.5, height: 140 });
      expect((await snapshot()).renders).toBe(previous.renders);
      expect((await snapshot()).created).toEqual(["main"]);
      expect(await page.locator("#input").inputValue()).toBe("edited");
      expect(
        await page
          .locator("#input")
          .evaluate((node) => node === document.activeElement)
      ).toBe(true);
    });

    it("applies radius changes using the last size without resubscribing", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 20,
          style: { width: 240, height: 140 }
        })
      );
      await masked();
      const before = await geometry();
      const resource = await image();
      await page.evaluate(() => window.SquircleFixture.update({ radius: 32 }));
      expect((await geometry())?.path).not.toBe(before?.path);
      expect(await image()).toBe(resource);
      expect((await snapshot()).created).toEqual(["main"]);
    });

    it("keeps physical border boxes across writing-mode changes", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ style: { width: 240, height: 140 } })
      );
      for (const [index, writingMode] of [
        "horizontal-tb",
        "vertical-rl",
        "sideways-lr"
      ].entries()) {
        const width = 240 + index * 20.25;
        await page.locator("#mask").evaluate(
          (node, { width, writingMode }) => {
            Object.assign(node.style, {
              width: `${width}px`,
              writingMode,
              padding: "8px 16px 12px 20px",
              border: "2px solid black"
            });
          },
          { width, writingMode }
        );
        await expect.poll(geometry).toMatchObject({ width, height: 140 });
      }
    });

    it("preserves the host and child state across native, fixed and responsive modes", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          smoothing: 0,
          style: { width: 240, height: 140 }
        })
      );
      expect(await image()).toBe("none");
      await page.locator("#input").fill("keep this");
      await page.evaluate(() =>
        window.SquircleFixture.update({
          width: 240,
          height: 140,
          smoothing: 0.6
        })
      );
      await masked();
      await page.evaluate(() =>
        window.SquircleFixture.update({ width: undefined, height: undefined })
      );
      await masked();
      await page.evaluate(() =>
        window.SquircleFixture.update({ smoothing: 0 })
      );
      expect(await image()).toBe("none");
      expect(await snapshot()).toMatchObject({ sameHost: true, active: 0 });
      expect(await page.locator("#input").inputValue()).toBe("keep this");
    });

    it("rebinds observation and cleans up refs when as changes the root", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ style: { width: 240, height: 140 } })
      );
      await masked();
      await page.evaluate(() =>
        window.SquircleFixture.update({ as: "section" })
      );
      await masked();
      expect(await snapshot()).toMatchObject({
        active: 1,
        sameHost: false,
        events: ["attach:DIV", "cleanup:DIV", "attach:SECTION"]
      });
      await page.evaluate(() => window.SquircleFixture.unmount());
      expect(await snapshot()).toMatchObject({
        active: 0,
        events: [
          "attach:DIV",
          "cleanup:DIV",
          "attach:SECTION",
          "cleanup:SECTION"
        ]
      });
    });

    it("supports a custom as target that forwards style and ref", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount(
          { style: { width: 240, height: 140 } },
          false,
          true
        )
      );
      await masked();
      expect(await page.locator("#mask").getAttribute("data-forwarded")).toBe(
        "yes"
      );
    });

    it("cleans up Strict Mode replay and final unmount", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount(
          { style: { width: 240, height: 140 } },
          true
        )
      );
      await masked();
      expect((await snapshot()).active).toBe(1);
      await page.evaluate(() => window.SquircleFixture.unmount());
      const state = await snapshot();
      expect(state.active).toBe(0);
      expect(
        state.events.filter((event) => event.startsWith("attach")).length
      ).toBe(
        state.events.filter((event) => event.startsWith("cleanup")).length
      );
      expect(pageErrors).toEqual([]);
    });

    it("uses the iframe's observer and releases both documents", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ style: { width: 240, height: 140 } })
      );
      await masked();
      await page.evaluate(() => window.SquircleFixture.mountFrame());
      await expect
        .poll(() =>
          page
            .frameLocator("iframe")
            .locator("#frame-mask")
            .evaluate((node) => getComputedStyle(node).maskImage)
        )
        .toMatch(/#mincho-squircle-/);
      expect(await snapshot()).toMatchObject({
        active: 2,
        created: ["main", "frame"]
      });
      await page.evaluate(() => window.SquircleFixture.unmount());
      expect((await snapshot()).active).toBe(0);
    });

    it("keeps a rounded fallback without ResizeObserver", async () => {
      await page.evaluate(() => {
        window.SquircleFixture.observation(false);
        window.SquircleFixture.mount({
          radius: 20,
          style: { width: 240, height: 140 }
        });
      });
      expect(await image()).toBe("none");
      expect((await snapshot()).created).toEqual([]);
      expect(
        await page
          .locator("#mask")
          .evaluate((node) => getComputedStyle(node).borderRadius)
      ).toBe("20px");
    });

    it("does not inherit a parent's mask before the first observation", async () => {
      expect(await page.evaluate(() => window.SquircleFixture.nested())).toBe(
        "none"
      );
      await masked();
      expect(await geometry()).toMatchObject({ width: 200, height: 120 });
    });

    it.each([true, false])(
      "keeps one painted mask during slider updates (fixed: %s)",
      async (fixed) => {
        await page.evaluate(
          (fixed) =>
            window.SquircleFixture.mount({
              ...(fixed ? { width: 240, height: 140 } : {}),
              radius: 30,
              style: { width: 240, height: 140, background: "rgb(0, 170, 119)" }
            }),
          fixed
        );
        await masked();
        const rect = (await page.locator("#mask").boundingBox())!;
        // A computed mask URL is insufficient: verify that the painted corners clip.
        expect(await pixel(rect.x + 1, rect.y + 1)).toEqual([
          255, 255, 255, 255
        ]);
        expect(await pixel(rect.x + 100, rect.y + 80)).toEqual([
          0, 170, 119, 255
        ]);
        const result = await page.evaluate(async (fixed) => {
          const resources = new Set<string>();
          const declarations = new Set<string>();
          const before = window.SquircleFixture.snapshot();
          const node = document.getElementById("mask")!;
          for (let i = 0; i < 60; i++) {
            await new Promise(requestAnimationFrame);
            window.SquircleFixture.update({
              ...(fixed ? { width: 240 + i } : {}),
              radius: 30 + i * 0.1,
              style: {
                width: 240 + i,
                height: 140,
                background: "rgb(0, 170, 119)"
              }
            });
            resources.add(getComputedStyle(node).maskImage);
            declarations.add(node.style.maskImage);
          }
          return {
            resources: [...resources],
            declarations: [...declarations],
            encodes: window.SquircleFixture.snapshot().encodes - before.encodes,
            // Exclude this test's one getComputedStyle call per update.
            styleReads:
              window.SquircleFixture.snapshot().reads - before.reads - 60,
            containers: document.querySelectorAll(
              "[data-mincho-squircle-resources]"
            ).length,
            masks: document.querySelectorAll(
              "[data-mincho-squircle-resources] mask"
            ).length
          };
        }, fixed);
        expect(result.resources).toHaveLength(1);
        expect(result.declarations).toHaveLength(1);
        expect(result.encodes).toBe(0);
        expect(result.styleReads).toBe(0);
        expect(result).toMatchObject({ containers: 1, masks: 1 });
        await expect.poll(geometry).toMatchObject({ width: 299, height: 140 });
        expect(await pixel(rect.x + 100, rect.y + 80)).toEqual([
          0, 170, 119, 255
        ]);
        expect(await pixel(rect.x + 270, rect.y + 80)).toEqual([
          0, 170, 119, 255
        ]);
        await page.evaluate(() =>
          window.SquircleFixture.update({ radius: 10 })
        );
        expect(await pixel(rect.x + 289, rect.y + 130)).toEqual([
          0, 170, 119, 255
        ]);
        await page.evaluate(() =>
          window.SquircleFixture.update({ radius: 60 })
        );
        expect(await pixel(rect.x + 289, rect.y + 130)).toEqual([
          255, 255, 255, 255
        ]);
        expect(await image()).toBe(result.resources[0]);
        await page.evaluate(() => window.SquircleFixture.unmount());
        expect(
          await page.locator("[data-mincho-squircle-resources]").count()
        ).toBe(0);
      }
    );

    it("scopes painted resources to a shadow root and releases them", async () => {
      await page.evaluate(() => window.SquircleFixture.mountShadow());
      await masked();
      const rect = (await page.locator("#mask").boundingBox())!;
      expect(await pixel(rect.x + 1, rect.y + 1)).toEqual([255, 255, 255, 255]);
      expect(await pixel(rect.x + 100, rect.y + 80)).toEqual([
        0, 170, 119, 255
      ]);
      await page.evaluate(() => window.SquircleFixture.unmount());
      expect(
        await page.locator("[data-mincho-squircle-resources]").count()
      ).toBe(0);
    });

    it("keeps fragment masks local with a document base URL", async () => {
      await page.evaluate(() => {
        const base = document.createElement("base");
        base.href = "https://example.invalid/other/";
        document.head.appendChild(base);
        window.SquircleFixture.mount({
          width: 240,
          height: 140,
          radius: 40,
          style: { background: "rgb(0, 170, 119)" }
        });
      });
      try {
        const rect = (await page.locator("#mask").boundingBox())!;
        expect(await pixel(rect.x + 1, rect.y + 1)).toEqual([
          255, 255, 255, 255
        ]);
        expect(await pixel(rect.x + 100, rect.y + 80)).toEqual([
          0, 170, 119, 255
        ]);
      } finally {
        await page.evaluate(() => document.querySelector("base")?.remove());
      }
    });

    it("keeps the mask visible with global SVG fill styles", async () => {
      const style = await page.addStyleTag({ content: "path { fill: none; }" });
      try {
        await page.evaluate(() =>
          window.SquircleFixture.mount({
            width: 240,
            height: 140,
            radius: 40,
            style: { background: "rgb(0, 170, 119)" }
          })
        );
        const rect = (await page.locator("#mask").boundingBox())!;
        expect(await pixel(rect.x + 1, rect.y + 1)).toEqual([
          255, 255, 255, 255
        ]);
        expect(await pixel(rect.x + 100, rect.y + 80)).toEqual([
          0, 170, 119, 255
        ]);
      } finally {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
      }
    });

    it.each([true, false])(
      "hydrates without mismatches (fixed: %s)",
      async (fixed) => {
        const options = fixed
          ? { width: 240, height: 140, radius: 20 }
          : { radius: 20, style: { width: 240, height: 140 } };
        const html = renderToString(
          createElement(
            SquircleMask,
            { id: "mask", ...options },
            createElement("input", { id: "input", defaultValue: "keep" })
          )
        );
        await page.evaluate(
          ({ html, options }) => window.SquircleFixture.hydrate(html, options),
          { html, options }
        );
        await expect
          .poll(() => page.evaluate(() => window.SquircleFixture.hydrated))
          .toBe(true);
        await masked();
        expect(
          await page.evaluate(() => window.SquircleFixture.errors)
        ).toEqual([]);
        expect(pageErrors).toEqual([]);
      }
    );
  }
);
