import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { build, createServer, preview } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-tailwind-react/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe
  .skipIf(process.env.MINCHO_TAILWIND_BROWSER !== "1")
  .each(["development", "production"] as const)(
  "Tailwind styles (%s)",
  (mode) => {
    let browser: Browser;
    let page: Page;
    let closeServer: (() => Promise<void>) | undefined;
    let directory: string;
    let url: string;
    const errors: string[] = [];

    beforeAll(async () => {
      const root = process.cwd();
      directory = await mkdtemp(join(tmpdir(), "mincho-tailwind-browser-"));
      const plugins = [
        minchoVitePlugin({
          jsxCssProp: { importSource: "@mincho-js/preset-tailwind-react" },
          extractCalls
        }),
        vanillaExtractPlugin(),
        react({ jsxImportSource: "@mincho-js/preset-tailwind-react" })
      ];

      if (mode === "production") {
        await build({
          root,
          configFile: false,
          plugins,
          logLevel: "silent",
          build: { outDir: directory, emptyOutDir: true }
        });

        const assets = await readdir(join(directory, "assets"));
        const code = (
          await Promise.all(
            assets
              .filter((name) => name.endsWith(".js"))
              .map((name) => readFile(join(directory, "assets", name), "utf8"))
          )
        ).join("\n");

        expect(code).not.toMatch(
          /themeSpec|breakpointEntries|registerClassName|appendCss|@tailwindcss|tailwindcss\/lib/
        );

        const server = await preview({
          root,
          configFile: false,
          build: { outDir: directory },
          preview: { host: "127.0.0.1", port: 0 }
        });
        url = server.resolvedUrls!.local[0];
        closeServer = () =>
          new Promise((resolve, reject) =>
            server.httpServer.close((error) =>
              error ? reject(error) : resolve()
            )
          );
      } else {
        const server = await createServer({
          root,
          configFile: false,
          plugins,
          logLevel: "silent",
          server: { host: "127.0.0.1", port: 0 }
        });
        await server.listen();
        url = server.resolvedUrls!.local[0];
        closeServer = () => server.close();
      }

      browser = await chromium.launch({
        executablePath:
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
          process.env.MINCHO_BROWSER_BINARY
      });
    }, 60_000);

    afterAll(async () => {
      try {
        await browser?.close();
      } finally {
        try {
          await closeServer?.();
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    });

    beforeEach(async () => {
      errors.length = 0;
      page = await browser.newPage({
        colorScheme: "light",
        viewport: { width: 1280, height: 900 }
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator("#recipe").waitFor();
    });

    afterEach(async () => {
      await page?.close();
      expect(errors).toEqual([]);
    });

    const css = (selector: string, property: string) =>
      page
        .locator(selector)
        .evaluate(
          (node, prop) => getComputedStyle(node).getPropertyValue(prop),
          property
        );

    it("resolves token spacing, font pairs and responsive layouts", async () => {
      expect(await css("#custom", "padding-left")).toBe("32px");
      expect(await css("#spacing", "padding-left")).toBe("5px");
      expect(await css("#spacing", "margin-left")).toBe("-8px");
      expect(await css("#spacing", "font-size")).toBe("18px");
      expect(await css("#spacing", "line-height")).toBe("28px");
      expect(await css("#custom h2", "font-size")).toBe("36px");
      expect(await css("#preset", "max-width")).toBe("1280px");
      expect(
        (await css("#demonstrations", "grid-template-columns")).split(" ")
      ).toHaveLength(2);

      await page.setViewportSize({ width: 375, height: 812 });
      expect(await css("#custom", "padding-left")).toBe("24px");
      expect(await css("#custom h2", "font-size")).toBe("30px");
      expect(await css("#preset", "max-width")).toBe("none");
      expect(
        (await css("#demonstrations", "grid-template-columns")).split(" ")
      ).toHaveLength(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);
    });

    it("selects preset styled variants and switches values on a shared contract", async () => {
      const initialBadgeColor = await css("#preset-badge", "background-color");

      expect(await css("#recipe", "background-color")).toBe(
        "rgb(102, 51, 153)"
      );
      expect(await css("#recipe", "padding-left")).toBe("16px");
      await page.locator("#size").click();
      expect(await css("#recipe", "padding-left")).toBe("24px");
      expect(await css("#recipe", "font-size")).toBe("18px");
      await page.locator("#tone").click();
      expect(await css("#recipe", "background-color")).toMatch(/^oklch\(/);
      expect(await css("#preset-badge", "background-color")).not.toBe(
        initialBadgeColor
      );
      expect(await page.locator("#preset-badge").getAttribute("tone")).toBe(
        null
      );
      await page.locator("#mode").click();
      expect(await css("#custom", "background-color")).toBe("rgb(23, 35, 26)");
      expect(await css("#custom", "color")).toBe("rgb(255, 255, 255)");
      await page.locator("#mode").click();
      expect(await css("#custom", "background-color")).toBe(
        "rgb(255, 255, 255)"
      );
    });

    it("applies compound accessibility, truncation and clamp declarations", async () => {
      expect(await css("#sr-only", "width")).toBe("1px");
      expect(await css("#sr-only", "clip-path")).toBe("inset(50%)");
      expect(await css("#truncated", "text-overflow")).toBe("ellipsis");
      expect(await css("#truncated", "white-space")).toBe("nowrap");
      expect(await css("#clamped", "-webkit-line-clamp")).toBe("2");
      expect(await css("#clamped", "overflow")).toBe("hidden");
    });

    it("compiles preset css props into atomic classes", async () => {
      expect(await page.locator("[css]").count()).toBe(0);
      expect(await css("#preset-primary", "font-weight")).toBe("700");
      expect(await css("#preset-primary", "color")).toBe("rgb(255, 255, 255)");
      expect(await css("#preset-primary", "padding-left")).toBe("12px");
      expect(await css("#preset-primary", "padding-right")).toBe("12px");
      expect(await css("#preset-primary", "padding-top")).toBe("8px");
      expect(await css("#preset-primary", "padding-bottom")).toBe("8px");
      expect(await css("#preset-primary", "border-top-left-radius")).toBe(
        "4px"
      );
      expect(await css("#inline-spacing", "padding-left")).toBe("4px");
      expect(await css("#inline-spacing", "padding-right")).toBe("12px");
      expect(await css("#inline-spacing", "padding-top")).toBe("8px");
      expect(await css("#inline-spacing", "padding-bottom")).toBe("8px");
      const initial = await css("#preset-primary", "background-color");

      expect(initial).toMatch(/^oklch\(/);
      await page.locator("#preset-primary").hover();
      const hovered = await css("#preset-primary", "background-color");

      expect(hovered).toMatch(/^oklch\(/);
      expect(hovered).not.toBe(initial);
    });

    it("composes every shadow and uses shipped keyframes", async () => {
      const filter = await css("#effects", "filter");
      expect(filter).toContain("blur(0px)");
      expect(filter.match(/drop-shadow\(/g)).toHaveLength(2);
      expect(await css("#effects", "box-shadow")).toContain("inset");
      expect(await css("#animation", "animation-name")).not.toBe("none");
      expect(await css("#animation", "animation-duration")).toBe("2s");
      expect(
        await page
          .locator("#animation")
          .evaluate((node) => node.getAnimations().length)
      ).toBe(1);

      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await css("#animation", "animation-name")).toBe("none");
    });

    it("applies opt-in Preflight while leaving application rules in control", async () => {
      expect(await css("body", "margin-top")).toBe("0px");
      expect(await css("#recipe", "box-sizing")).toBe("border-box");
      expect(await css("h1", "font-weight")).toBe("700");
      expect(await css("body", "background-color")).toBe("rgb(244, 244, 241)");
      expect(
        await page.evaluate(() => {
          const node = document.createElement("div");
          node.hidden = true;
          node.style.display = "block";
          document.body.append(node);
          const display = getComputedStyle(node).display;
          node.remove();
          return display;
        })
      ).toBe("none");
    });
  }
);
