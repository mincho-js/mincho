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
import { extractCalls } from "@mincho-js/preset-theme-ui-react/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe
  .skipIf(process.env.MINCHO_THEME_UI_BROWSER !== "1")
  .each(["development", "production"] as const)(
  "Theme UI presets (%s)",
  (mode) => {
    let browser: Browser;
    let page: Page;
    let closeServer: (() => Promise<void>) | undefined;
    let directory: string;
    let url: string;
    const errors: string[] = [];

    beforeAll(async () => {
      const root = process.cwd();
      directory = await mkdtemp(join(tmpdir(), "mincho-theme-ui-browser-"));
      const plugins = [
        minchoVitePlugin({
          jsxCssProp: { importSource: "@mincho-js/preset-theme-ui-react" },
          extractCalls
        }),
        vanillaExtractPlugin(),
        react({ jsxImportSource: "@mincho-js/preset-theme-ui-react" })
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
          /createPresetStyles|normalizeTheme|themeSpec|createComponents|defineVariants|registerClassName|appendCss|@theme-ui|@emotion/
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
      await page.locator("#dark h1").waitFor();
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

    it("renders all presets with responsive typography and token spacing", async () => {
      expect(await css("#base", "background-color")).toBe("rgb(255, 255, 255)");
      expect(await css("#dark", "background-color")).toBe("rgb(6, 6, 6)");
      expect(await css("#system h1", "font-size")).toBe("48px");
      expect(await css("#system h1", "font-weight")).toBe("900");
      expect(await css("#system h1", "line-height")).toBe("60px");
      expect(await css("#base h1", "font-size")).toBe("32px");
      expect(await css("#recipe", "font-size")).toBe("48px");
      expect(await css("#spacing", "padding-left")).toBe("8px");
      expect(await css("#spacing", "margin-left")).toBe("-4px");
      expect(await css("#system", "line-height")).toBe("24px");

      await page.setViewportSize({ width: 375, height: 812 });
      expect(await css("#system h1", "font-size")).toBe("32px");
      expect(await css("#dark h1", "font-size")).toBe("32px");
      expect(await css("#recipe", "font-size")).toBe("32px");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);
    });

    it.each([
      ["default", "#fff"],
      ["dark", "#060606"],
      ["deep", "hsl(230, 25%, 18%)"],
      ["swiss", "hsl(10, 10%, 98%)"]
    ])(
      "switches %s while preserving nested and sibling themes",
      async (modeName, color) => {
        await page.selectOption("#mode", modeName);
        const expected = await page.evaluate((value) => {
          const node = document.createElement("div");
          node.style.backgroundColor = value;
          document.body.append(node);

          const result = getComputedStyle(node).backgroundColor;
          node.remove();

          return result;
        }, color);

        expect(await css("#system", "background-color")).toBe(expected);
        expect(await css("#nested", "background-color")).toBe(
          "rgb(255, 255, 255)"
        );
        expect(await css("#nested", "color")).toBe("rgb(0, 0, 0)");
        expect(await css("#base", "background-color")).toBe(
          "rgb(255, 255, 255)"
        );
        expect(await css("#outside", "font-size")).toBe("28px");
      }
    );

    it("customizes token values with native rules and color modes", async () => {
      expect(await css("#custom-button", "background-color")).toBe(
        "rgb(102, 51, 153)"
      );
      expect(await css("#custom-button", "padding-left")).toBe("32px");
      expect(await css("#custom-dark button", "background-color")).toBe(
        "rgb(102, 51, 153)"
      );
      expect(await css("#custom-dark button", "color")).toBe("rgb(23, 35, 26)");

      await page.setViewportSize({ width: 375, height: 812 });
      expect(await css("#custom-button", "padding-left")).toBe("8px");
    });

    it("selects semantic component variants without forwarding variant props", async () => {
      const button = page.locator("#variant-button");

      expect(await css("#variant-button", "background-color")).toBe(
        "rgb(51, 51, 238)"
      );
      await button.click();
      expect(await css("#variant-button", "background-color")).toBe(
        "rgb(17, 17, 153)"
      );

      await page.selectOption("#mode", "dark");
      expect(await css("#variant-button", "background-color")).toBe(
        "rgb(238, 0, 255)"
      );
      expect(await css("#variant-button", "color")).toBe("rgb(6, 6, 6)");
      expect(await button.getAttribute("variant")).toBeNull();
      expect(
        await page.locator("#system h1").getAttribute("variant")
      ).toBeNull();
    });

    it("lets inline CSS override component defaults and variants across conditions", async () => {
      const button = page.locator("#inline-button");

      expect(await css("#variant-button", "padding-left")).toBe("16px");
      expect(await css("#variant-button", "background-color")).toBe(
        "rgb(51, 51, 238)"
      );
      expect(await css("#inline-button", "padding-left")).toBe("64px");
      expect(await css("#inline-button", "padding-right")).toBe("64px");
      expect(await css("#inline-button", "background-color")).toBe(
        "rgb(17, 17, 153)"
      );
      expect(await css("#inline-button", "color")).toBe("rgb(255, 255, 255)");

      await page.setViewportSize({ width: 375, height: 812 });
      expect(await css("#inline-button", "padding-left")).toBe("32px");
      expect(await css("#inline-button", "padding-right")).toBe("32px");

      await button.hover();
      expect(await css("#inline-button", "background-color")).toBe(
        "rgb(102, 0, 153)"
      );

      await page.selectOption("#mode", "dark");
      await button.hover();
      expect(await css("#inline-button", "background-color")).toBe(
        "rgb(204, 0, 255)"
      );
      await page.mouse.move(0, 0);
      expect(await css("#inline-button", "background-color")).toBe(
        "rgb(238, 0, 255)"
      );
      expect(await css("#inline-button", "color")).toBe("rgb(6, 6, 6)");
      expect(await button.getAttribute("css")).toBeNull();
      expect(await button.getAttribute("variant")).toBeNull();
    });

    it("follows OS changes until the application selects an explicit mode", async () => {
      await page.emulateMedia({ colorScheme: "dark" });
      await expect
        .poll(() => css("#system", "background-color"))
        .toBe("rgb(6, 6, 6)");

      await page.selectOption("#mode", "default");
      expect(await css("#system", "background-color")).toBe(
        "rgb(255, 255, 255)"
      );
    });

    it("compiles the preset link variant's pseudo states", async () => {
      expect(await css("#system a", "color")).toBe("rgb(51, 51, 238)");
      await page.locator("#system a").hover();
      expect(await css("#system a", "color")).toBe("rgb(17, 17, 153)");
    });
  }
);
