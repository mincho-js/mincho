import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";
import { resolveSsrTheme } from "@mincho-js/vite/ssr";

const binary = process.env.MINCHO_BROWSER_BINARY;
if (!binary || typeof globalThis.WebSocket !== "function") {
  console.log(
    binary
      ? "[package-contract] theme browser check skipped: this Node runtime has no global WebSocket"
      : "[package-contract] theme browser check skipped: MINCHO_BROWSER_BINARY is unset"
  );
} else {
  const root = resolve("fixture/modules/themes-browser");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<script type="module" src="/main.js"></script>'
  );
  await writeFile(
    join(root, "main.js"),
    `import {createThemeController} from '@mincho-js/vite/themes';
    globalThis.boot=(async()=>{const manifest=await fetch('/app/.vite/mincho-css-manifest.json').then(r=>r.json());
    globalThis.controller=createThemeController(manifest,{initial:globalThis.initial,persistence:false});
    await controller.ready;globalThis.started=true;return true})()`
  );
  for (const [id, color] of [
    ["light", "red"],
    ["dark", "blue"],
    ["contrast", "green"]
  ])
    await writeFile(
      join(root, `${id}.js`),
      `import {css} from '@mincho-js/css';export const themeClass=css({color:'${color}'});`
    );
  await build({
    root,
    base: "/app/",
    configFile: false,
    logLevel: "silent",
    plugins: [
      minchoVitePlugin({
        cache: false,
        appCss: {
          mode: "dist-chunk",
          themes: {
            default: "light",
            system: { light: "light", dark: "dark" },
            entries: ["light", "dark", "contrast"].map((id) => ({
              id,
              entry: `${id}.js`
            }))
          }
        }
      })
    ],
    build: { minify: true }
  });
  const dist = join(root, "dist");
  const manifest = JSON.parse(
    await readFile(join(dist, ".vite/mincho-css-manifest.json"), "utf8")
  );
  const initial = resolveSsrTheme(manifest, {
    preference: "light",
    selection: { entries: ["index.html"] }
  });
  const shell = await readFile(join(dist, "index.html"), "utf8");
  const html = `<!doctype html><html class="appRoot ${initial.attributes.class}"><head>${initial.stylesheets.map((sheet) => `<link rel="stylesheet" href="${sheet.href}">`).join("")}<script>globalThis.initial=${JSON.stringify(initial.snapshot)}</script>${shell}</head><body>theme fixture</body></html>`;
  const requests = [];
  const contrastCss = manifest.themes.entries.contrast.css;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      requests.push(pathname);
      if (pathname === "/app/") {
        res
          .writeHead(200, {
            "Content-Type": "text/html",
            "Content-Security-Policy": "style-src 'self'"
          })
          .end(html);
        return;
      }
      const file = decodeURIComponent(pathname.replace(/^\/app\//, ""));
      if (file.includes("..") || file.startsWith("/")) {
        res.writeHead(404).end();
        return;
      }
      if (contrastCss.includes(file)) {
        await new Promise((done) => setTimeout(done, 150));
        res.writeHead(500).end();
        return;
      }
      const contents = await readFile(join(dist, file));
      if (file.endsWith(".css"))
        await new Promise((done) => setTimeout(done, 50));
      res
        .writeHead(200, {
          "Content-Type": file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".js")
              ? "text/javascript"
              : "application/json",
          "Cache-Control": "public, max-age=600"
        })
        .end(contents);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const profile = await mkdtemp(join(tmpdir(), "mincho-theme-browser-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const closed = new Promise((done) => child.once("close", done));
  let socket,
    serial = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((yes, no) => {
      const id = ++serial;
      const timeout = setTimeout(() => {
        pending.delete(id);
        no(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          yes(value);
        },
        reject(error) {
          clearTimeout(timeout);
          no(error);
        }
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })
      );
    });
  try {
    const endpoint = await new Promise((yes, no) => {
      let text = "";
      const timeout = setTimeout(
        () => no(new Error("Chromium startup timeout")),
        15000
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        no(error);
      });
      child.stderr.on("data", (data) => {
        text += data;
        const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          yes(match[1]);
        }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((yes, no) => {
      socket.addEventListener("open", yes, { once: true });
      socket.addEventListener("error", no, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      const result = JSON.parse(data);
      const request = pending.get(result.id);
      if (request) {
        pending.delete(result.id);
        result.error
          ? request.reject(Error(JSON.stringify(result.error)))
          : request.resolve(result.result);
      }
    });
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank"
    });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    const evaluate = async (expression) => {
      const result = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send(
      "Page.navigate",
      { url: `http://127.0.0.1:${server.address().port}/app/` },
      sessionId
    );
    await evaluate(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+15000;const poll=()=>globalThis.started?resolve(true):Date.now()>deadline?reject(Error('theme boot timeout')):setTimeout(poll,20);poll()})`
    );
    assert.equal(
      await evaluate("getComputedStyle(document.documentElement).color"),
      "rgb(255, 0, 0)"
    );
    const behavior = await evaluate(
      `(async()=>{const color=()=>getComputedStyle(document.documentElement).color;await controller.preloadTheme('dark');const preload=color();const switching=controller.setTheme('dark');const pending=color();await switching;const dark=color();const failure=controller.setTheme('contrast').catch(()=>false);await controller.setTheme('light');await failure;return {preload,pending,dark,last:color(),snapshot:controller.getSnapshot(),root:document.documentElement.classList.contains('appRoot')}})()`
    );
    assert.equal(behavior.preload, "rgb(255, 0, 0)");
    assert.equal(behavior.pending, "rgb(255, 0, 0)");
    assert.equal(behavior.dark, "rgb(0, 0, 255)");
    assert.equal(behavior.last, "rgb(255, 0, 0)");
    assert.equal(behavior.snapshot.resolved, "light");
    assert.equal(behavior.snapshot.status, "ready");
    assert.equal(behavior.root, true);
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: "dark" }] },
      sessionId
    );
    assert.equal(
      await evaluate(
        "controller.setTheme('system').then(value=>value.resolved)"
      ),
      "dark"
    );
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: "light" }] },
      sessionId
    );
    await evaluate(
      "new Promise(resolve=>{const stop=controller.subscribe(()=>{if(controller.getSnapshot().resolved==='light'){stop();resolve(true)}});if(controller.getSnapshot().resolved==='light'){stop();resolve(true)}})"
    );
    const links = await evaluate(
      "document.querySelectorAll('link[rel=stylesheet]').length"
    );
    await evaluate("controller.dispose()");
    assert.equal(
      await evaluate(
        "document.querySelectorAll('link[rel=stylesheet]').length"
      ),
      links
    );
    assert.equal(
      await evaluate("getComputedStyle(document.documentElement).color"),
      "rgb(255, 0, 0)"
    );
    for (const file of manifest.themes.entries.dark.css)
      assert.equal(
        requests.filter((path) => path === `/app/${file}`).length,
        1
      );
    console.log(
      "[package-contract] lazy themes: SSR CSS, external-style CSP, load-before-commit, latest request, failure, OS preference, shared preload and dispose passed"
    );
  } finally {
    for (const request of pending.values())
      request.reject(new Error("Browser session closed"));
    socket?.close();
    child.kill("SIGTERM");
    await closed;
    await new Promise((done) => server.close(done));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
}
