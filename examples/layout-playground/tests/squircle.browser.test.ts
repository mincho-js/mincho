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
    let fixtureCode: string;
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
      fixtureCode = result.outputFiles[0].text;
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
      await page.addScriptTag({ content: fixtureCode });
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
        window.SquircleFixture.shapeSupport(true);
      });
    });
    const clip = () =>
      page.locator("#mask").evaluate((node) => getComputedStyle(node).clipPath);
    const radius = () =>
      page
        .locator("#mask")
        .evaluate((node) => getComputedStyle(node).borderRadius);
    async function clipped(kind: "path" | "shape" = "path") {
      await expect.poll(clip).toMatch(new RegExp(`^${kind}\\(`));
    }
    // Border box covered by a measured path() clip, or null for shape()/none.
    const geometry = async () => {
      const value = await clip();
      const path = /^path\("(.*)"\)$/.exec(value)?.[1];
      if (!path) return null;
      let width = 0;
      let height = 0;
      // Corners are relative to the segment start. Chromium serializes them as
      // absolute commands; Firefox and WebKit keep them relative.
      let [x, y] = [0, 0];
      for (const [, command, args] of path.matchAll(/([MLCAZ])([^MLCAZ]*)/gi)) {
        const n = args.trim().split(/[ ,]+/).filter(Boolean).map(Number);
        const xy = command.toUpperCase() === "A" ? n.slice(5) : n;
        const [ox, oy] = command === command.toLowerCase() ? [x, y] : [0, 0];
        for (let i = 0; i < xy.length; i += 2) {
          width = Math.max(width, ox + xy[i]);
          height = Math.max(height, oy + xy[i + 1]);
        }
        if (xy.length) [x, y] = [ox + xy.at(-2)!, oy + xy.at(-1)!];
      }
      // Relative offsets carry up to 1e-4px rounding per segment.
      const round = (n: number) => Math.round(n * 1000) / 1000;
      return { width: round(width), height: round(height), path };
    };
    async function pixel(x: number, y: number, target = page) {
      const shot = await target.screenshot({
        clip: { x, y, width: 1, height: 1 }
      });
      return target.evaluate(
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
    const white = [255, 255, 255, 255];
    const green = [0, 170, 119, 255];
    async function paintsCorners() {
      const rect = (await page.locator("#mask").boundingBox())!;
      // A computed clip is insufficient: verify that the painted corners clip.
      expect(await pixel(rect.x + 1, rect.y + 1)).toEqual(white);
      expect(await pixel(rect.x + rect.width - 2, rect.y + 1)).toEqual(white);
      expect(await pixel(rect.x + 100, rect.y + 80)).toEqual(green);
      return rect;
    }
    const snapshot = () =>
      page.evaluate(() => window.SquircleFixture.snapshot());
    const svgResources = () =>
      page.evaluate(() => document.querySelectorAll("svg, mask").length);
    async function isolated(run: (target: Page) => Promise<void>) {
      const target = await browser.newPage();
      target.on("pageerror", (error) => pageErrors.push(error.message));
      try {
        await run(target);
      } finally {
        await target.close();
      }
    }

    it("renders fixed clips without observers or computed-style reads", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          width: 240,
          height: 140,
          radius: 24,
          style: { background: "rgb(0, 170, 119)" }
        })
      );
      expect(await snapshot()).toMatchObject({
        created: [],
        active: 0,
        reads: 0,
        encodes: 0
      });
      await clipped("path");
      expect(await geometry()).toMatchObject({ width: 240, height: 140 });
      expect(await radius()).toBe("0px");
      expect(await page.locator("#mask").boundingBox()).toMatchObject({
        width: 240,
        height: 140
      });
      await paintsCorners();
      expect(await svgResources()).toBe(0);
    });

    it("paints responsive boxes without rebuilding the shared shape()", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 24,
          style: { width: 240, height: 140, background: "rgb(0, 170, 119)" }
        })
      );
      await clipped("shape");
      expect(await radius()).toBe("0px");
      const shape = await clip();
      await paintsCorners();
      await page.locator("#input").fill("edited");
      const previous = await snapshot();
      await page.locator("#mask").evaluate((node) => {
        node.style.width = "320.5px";
      });
      await expect
        .poll(() => page.locator("#mask").boundingBox())
        .toMatchObject({ width: 320.5 });
      expect(await clip()).toBe(shape);
      await paintsCorners();
      expect((await snapshot()).renders).toBe(previous.renders);
      expect((await snapshot()).created).toEqual(["main"]);
      expect(await page.locator("#input").inputValue()).toBe("edited");
      expect(
        await page
          .locator("#input")
          .evaluate((node) => node === document.activeElement)
      ).toBe(true);
      expect(await svgResources()).toBe(0);
    });

    it("measures border boxes where the size clamps smoothing", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 60,
          style: {
            width: 240,
            height: 140,
            padding: 10,
            border: "2px solid black"
          }
        })
      );
      await clipped("path");
      expect(await geometry()).toMatchObject({ width: 240, height: 140 });
      await page.locator("#input").fill("edited");
      const previous = await snapshot();
      await page.locator("#mask").evaluate((node) => {
        node.style.width = "320.5px";
      });
      await expect.poll(geometry).toMatchObject({ width: 320.5, height: 140 });
      // Growing past the smoothing budget returns to the shared shape().
      await page.locator("#mask").evaluate((node) => {
        node.style.height = "260px";
      });
      await clipped("shape");
      expect((await snapshot()).renders).toBe(previous.renders);
      expect((await snapshot()).created).toEqual(["main"]);
      expect(await page.locator("#input").inputValue()).toBe("edited");
    });

    it("applies radius changes using the last size without resubscribing", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 60,
          style: { width: 240, height: 140 }
        })
      );
      await clipped("path");
      const before = await geometry();
      await page.evaluate(() => window.SquircleFixture.update({ radius: 64 }));
      expect((await geometry())?.path).not.toBe(before?.path);
      expect((await snapshot()).created).toEqual(["main"]);
    });

    it("keeps physical border boxes across writing-mode changes", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 60,
          style: { width: 240, height: 140 }
        })
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
      expect(await clip()).toBe("none");
      await page.locator("#input").fill("keep this");
      await page.evaluate(() =>
        window.SquircleFixture.update({
          width: 240,
          height: 140,
          smoothing: 0.6
        })
      );
      await clipped("path");
      await page.evaluate(() =>
        window.SquircleFixture.update({ width: undefined, height: undefined })
      );
      await clipped("shape");
      await page.evaluate(() =>
        window.SquircleFixture.update({ smoothing: 0 })
      );
      expect(await clip()).toBe("none");
      expect(await radius()).toBe("24px");
      expect(await snapshot()).toMatchObject({ sameHost: true, active: 0 });
      expect(await page.locator("#input").inputValue()).toBe("keep this");
    });

    it("rebinds observation and cleans up refs when as changes the root", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ style: { width: 240, height: 140 } })
      );
      await clipped("shape");
      await page.evaluate(() =>
        window.SquircleFixture.update({ as: "section" })
      );
      await clipped("shape");
      expect(await radius()).toBe("0px");
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
      await clipped("shape");
      expect(await radius()).toBe("0px");
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
      await clipped("shape");
      expect((await snapshot()).active).toBe(1);
      await page.evaluate(() => window.SquircleFixture.unmount());
      const state = await snapshot();
      expect(state.active).toBe(0);
      expect(
        state.events.filter((event) => event.startsWith("attach")).length
      ).toBe(
        state.events.filter((event) => event.startsWith("cleanup")).length
      );
    });

    it("uses the iframe's observer and releases both documents", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({ style: { width: 240, height: 140 } })
      );
      await clipped("shape");
      await page.evaluate(() => window.SquircleFixture.mountFrame());
      await expect
        .poll(() =>
          page
            .frameLocator("iframe")
            .locator("#frame-mask")
            .evaluate((node) => getComputedStyle(node).clipPath)
        )
        .toMatch(/^shape\(/);
      expect(await snapshot()).toMatchObject({
        active: 2,
        created: ["main", "frame"]
      });
      await page.evaluate(() => window.SquircleFixture.unmount());
      expect((await snapshot()).active).toBe(0);
    });

    it("paints shape() without ResizeObserver", async () => {
      await page.evaluate(() => {
        window.SquircleFixture.observation(false);
        window.SquircleFixture.mount({
          radius: 20,
          style: { width: 240, height: 140, background: "rgb(0, 170, 119)" }
        });
      });
      await clipped("shape");
      expect(await radius()).toBe("0px");
      expect((await snapshot()).created).toEqual([]);
      await paintsCorners();
    });

    it("keeps a rounded fallback without shape() or ResizeObserver", async () => {
      await page.evaluate(() => {
        window.SquircleFixture.shapeSupport(false);
        window.SquircleFixture.observation(false);
        window.SquircleFixture.mount({
          radius: 20,
          style: { width: 240, height: 140 }
        });
      });
      expect((await snapshot()).created).toEqual([]);
      expect(await clip()).toBe("none");
      expect(await radius()).toBe("20px");
      await page.evaluate(() => window.SquircleFixture.update({ radius: 21 }));
      expect(await radius()).toBe("21px");
    });

    it("recreates a removed shared stylesheet", async () => {
      await page.evaluate(() =>
        window.SquircleFixture.mount({
          radius: 20,
          style: { width: 240, height: 140 }
        })
      );
      await clipped("shape");
      // A removed sheet is recreated with every retained rule.
      await page.evaluate(() => {
        document.querySelector("style[data-mincho-squircle]")!.remove();
        window.SquircleFixture.update({ radius: 21 });
      });
      expect(await radius()).toBe("0px");
      await clipped("shape");
    });

    it("shares one class rule and constant base styles between equal boxes", async () => {
      const result = await page.evaluate(() =>
        window.SquircleFixture.mountMany(24, { radius: 18, smoothing: 0.7 })
      );
      expect(result).toEqual({
        styles: [
          "box-sizing: border-box; overflow: hidden; border-radius: 0px;"
        ],
        classes: ["mincho-squircle mincho-squircle-r18-s0_7"],
        rules: 1
      });
      expect(
        await page.evaluate(() => window.SquircleFixture.ruleCount())
      ).toBe(result.rules);
      await page.evaluate(() => window.SquircleFixture.unmount());
      // Idle rules stay for remounts; they do not accumulate per element.
      expect(
        await page.evaluate(() => window.SquircleFixture.ruleCount())
      ).toBe(result.rules);
    });

    it("installs class rules inside shadow roots", async () => {
      await page.evaluate(() => window.SquircleFixture.mountShadow(true));
      const shadow = page.locator("#shadow-host #mask");
      await expect
        .poll(() => shadow.evaluate((node) => getComputedStyle(node).clipPath))
        .toMatch(/^shape\(/);
      expect(
        await shadow.evaluate((node) => getComputedStyle(node).borderRadius)
      ).toBe("0px");
    });

    it("measures paths for every size without shape()", async () => {
      await page.evaluate(() => {
        window.SquircleFixture.shapeSupport(false);
        window.SquircleFixture.mount({
          radius: 24,
          style: { width: 240, height: 140, background: "rgb(0, 170, 119)" }
        });
      });
      await clipped("path");
      expect(await geometry()).toMatchObject({ width: 240, height: 140 });
      expect(await radius()).toBe("0px");
      await paintsCorners();
      await page.locator("#mask").evaluate((node) => {
        node.style.width = "320.5px";
      });
      await expect.poll(geometry).toMatchObject({ width: 320.5, height: 140 });
      await paintsCorners();
    });

    it("does not inherit a parent's clip before the first observation", async () => {
      expect(
        await page.evaluate(() => window.SquircleFixture.nested())
      ).toMatch(/^shape\(/);
      await clipped("shape");
      expect(await radius()).toBe("0px");
    });

    it.each([true, false])(
      "keeps clipping when CSP blocks stylesheets (ResizeObserver: %s)",
      async (observe) =>
        isolated(async (target) => {
          await target.setContent(
            `<meta http-equiv="Content-Security-Policy" content="style-src-elem 'nonce-allowed'">`
          );
          await target.addScriptTag({ content: fixtureCode });
          await target.evaluate((observe) => {
            window.SquircleFixture.observation(observe);
            window.SquircleFixture.mount({
              radius: 24,
              style: { width: 240, height: 140, background: "rgb(0, 170, 119)" }
            });
          }, observe);
          const host = target.locator("#mask");
          const readClip = () =>
            host.evaluate((node) => getComputedStyle(node).clipPath);
          if (observe) await expect.poll(readClip).toMatch(/^path\(/);
          else expect(await readClip()).toBe("none");
          expect(
            await host.evaluate((node) => ({
              boxSizing: getComputedStyle(node).boxSizing,
              overflow: getComputedStyle(node).overflow,
              radius: getComputedStyle(node).borderRadius
            }))
          ).toEqual({
            boxSizing: "border-box",
            overflow: "hidden",
            radius: observe ? "0px" : "24px"
          });
          const rect = (await host.boundingBox())!;
          expect(
            await pixel(rect.x + rect.width - 2, rect.y + 1, target)
          ).toEqual(white);
          expect(await pixel(rect.x + 100, rect.y + 80, target)).toEqual(green);
          const before = await readClip();
          await target.locator("#input").fill("kept under CSP");
          await host.evaluate((node) => {
            node.style.width = "320px";
          });
          if (observe) await expect.poll(readClip).not.toBe(before);
          await target.evaluate(() =>
            window.SquircleFixture.update({ radius: 30 })
          );
          expect(
            await host.evaluate((node) => getComputedStyle(node).borderRadius)
          ).toBe(observe ? "0px" : "30px");
          expect(await target.locator("#input").inputValue()).toBe(
            "kept under CSP"
          );
          expect(
            await target.locator("style[data-mincho-squircle]").count()
          ).toBe(1);
          expect(
            await target
              .locator("style[data-mincho-squircle]")
              .evaluate((node) => (node as HTMLStyleElement).sheet === null)
          ).toBe(true);
          await target.evaluate(() => window.SquircleFixture.unmount());
          expect(
            (await target.evaluate(() => window.SquircleFixture.snapshot()))
              .active
          ).toBe(0);
        })
    );

    it("measures a path when insertion of a required class rule fails", async () => {
      await isolated(async (target) => {
        await target.addScriptTag({ content: fixtureCode });
        await target.evaluate(() => {
          const insert = CSSStyleSheet.prototype.insertRule;
          CSSStyleSheet.prototype.insertRule = function (text, index) {
            if (text.startsWith(".mincho-squircle-"))
              throw new DOMException("Rule rejected", "SyntaxError");
            return insert.call(this, text, index);
          };
          window.SquircleFixture.mount({
            radius: 24,
            style: { width: 240, height: 140 }
          });
        });
        const host = target.locator("#mask");
        await expect
          .poll(() => host.evaluate((node) => getComputedStyle(node).clipPath))
          .toMatch(/^path\(/);
        expect(
          await host.evaluate((node) => getComputedStyle(node).borderRadius)
        ).toBe("0px");
        expect(
          await target
            .locator("style[data-mincho-squircle]")
            .evaluate(
              (node) => (node as HTMLStyleElement).sheet!.cssRules.length
            )
        ).toBe(0);
      });
    });

    it("preserves the responsive border box from SSR through hydration", async () => {
      const options = {
        width: 240,
        radius: 24,
        style: { height: 140, padding: 20, border: "10px solid black" }
      };
      const html = renderToString(
        createElement(
          SquircleMask,
          { id: "mask", ...options },
          createElement("input", { id: "input", defaultValue: "keep" })
        )
      );
      await isolated(async (target) => {
        await target.setContent(html);
        const host = target.locator("#mask");
        const size = { width: 240, height: 140 };
        expect(await host.boundingBox()).toMatchObject(size);
        expect(
          await host.evaluate((node) => getComputedStyle(node).borderRadius)
        ).toBe("24px");
        await target.addScriptTag({ content: fixtureCode });
        await target.evaluate(
          ({ html, options }) => window.SquircleFixture.hydrate(html, options),
          { html, options }
        );
        await expect
          .poll(() => target.evaluate(() => window.SquircleFixture.hydrated))
          .toBe(true);
        expect(await host.boundingBox()).toMatchObject(size);
        expect(
          await host.evaluate((node) => getComputedStyle(node).clipPath)
        ).toMatch(/^shape\(/);
        expect(
          await target.evaluate(() => window.SquircleFixture.errors)
        ).toEqual([]);
      });
    });

    it.each([true, false])(
      "keeps clipping during slider updates without encoding (fixed: %s)",
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
        await clipped(fixed ? "path" : "shape");
        const rect = await paintsCorners();
        const result = await page.evaluate(async (fixed) => {
          const before = window.SquircleFixture.snapshot();
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
          }
          const after = window.SquircleFixture.snapshot();
          return {
            encodes: after.encodes - before.encodes,
            styleReads: after.reads - before.reads
          };
        }, fixed);
        expect(result).toEqual({ encodes: 0, styleReads: 0 });
        await clipped(fixed ? "path" : "shape");
        if (fixed)
          expect(await geometry()).toMatchObject({ width: 299, height: 140 });
        expect(await pixel(rect.x + 100, rect.y + 80)).toEqual(green);
        expect(await pixel(rect.x + 270, rect.y + 80)).toEqual(green);
        expect(await pixel(rect.x + 297, rect.y + 1)).toEqual(white);
        await page.evaluate(() =>
          window.SquircleFixture.update({ radius: 10 })
        );
        expect(await pixel(rect.x + 289, rect.y + 130)).toEqual(green);
        await page.evaluate(() =>
          window.SquircleFixture.update({ radius: 60 })
        );
        expect(await pixel(rect.x + 289, rect.y + 130)).toEqual(white);
        expect(await svgResources()).toBe(0);
      }
    );

    it("clips inside a shadow root without document resources", async () => {
      await page.evaluate(() => window.SquircleFixture.mountShadow());
      await clipped("path");
      await paintsCorners();
      expect(await svgResources()).toBe(0);
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
        expect(html).not.toContain("data:image");
        await page.evaluate(
          ({ html, options }) => window.SquircleFixture.hydrate(html, options),
          { html, options }
        );
        await expect
          .poll(() => page.evaluate(() => window.SquircleFixture.hydrated))
          .toBe(true);
        await clipped(fixed ? "path" : "shape");
        expect(await radius()).toBe("0px");
        expect(
          await page.evaluate(() => window.SquircleFixture.errors)
        ).toEqual([]);
        expect(pageErrors).toEqual([]);
      }
    );
  }
);
