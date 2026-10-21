import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
assert.ok(
  typeof WebSocket === "function",
  "Browser measurements require a global WebSocket (Node >= 22, or --experimental-websocket on Node 20)"
);

const build = JSON.parse(await readFile("build-results.json", "utf8"));
const extrasOnly = process.argv.includes("--extras");
const result = extrasOnly
  ? JSON.parse(await readFile("browser-results.json", "utf8"))
  : { css: {}, memo: { samples: [] } };

let activeDir,
  delayCss = false,
  requests = [];

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    let file;

    if (path === "/memo.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><div id="root"></div><script type="module" src="/memo.js"></script>'
      );

      return;
    }

    if (path === "/memo.js") file = join(root, "browser/memo.js");
    else file = join(activeDir, path.replace(/^\/app\//, ""));

    const data = await readFile(file);

    if (path.endsWith(".css")) {
      requests.push(path);

      if (delayCss) await new Promise((r) => setTimeout(r, 250));
    }

    res.setHeader(
      "Content-Type",
      { ".css": "text/css", ".js": "text/javascript", ".html": "text/html" }[
        extname(file)
      ] ?? "application/octet-stream"
    );
    res.setHeader("Cache-Control", "public, max-age=600");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "mincho-followup-chrome-"));
const chrome = spawn(
  process.env.CHROME_BIN ?? "/usr/bin/chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const closed = new Promise((r) => {
  chrome.once("exit", r);
  chrome.once("error", r);
});
let socket,
  id = 0;

const pending = new Map();

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => {
      pending.delete(current);
      reject(Error(`timeout ${method}`));
    }, 30000);

    pending.set(current, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },

      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      }
    });
    socket.send(
      JSON.stringify({
        id: current,
        method,
        params,
        ...(sessionId ? { sessionId } : {})
      })
    );
  });

try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    chrome.once("error", reject);
    chrome.once("exit", (code, signal) =>
      reject(
        Error(
          `Chromium exited before the DevTools endpoint (code ${code}, signal ${signal ?? "none"})`
        )
      )
    );
    chrome.stderr.on("data", (data) => {
      output += data;

      const m = output.match(/DevTools listening on (ws:\/\/\S+)/);

      if (m) resolve(m[1]);
    });
  });

  socket = new WebSocket(endpoint);
  await new Promise((r, j) => {
    socket.addEventListener("open", r, { once: true });
    socket.addEventListener("error", j, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);

    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  result.browser = await send("Browser.getVersion");

  async function page(path, ready) {
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank"
    });

    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true
    });

    const evaluate = async (expression) => {
      const r = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));

      return r.result.value;
    };

    await send("Page.enable", {}, sessionId);
    await send("Network.enable", {}, sessionId);
    await send("Network.clearBrowserCache", {}, sessionId);
    await send("Page.navigate", { url: origin + path }, sessionId);

    const deadline = Date.now() + 15000;

    while (!(await evaluate(ready))) {
      if (Date.now() > deadline) throw Error("page did not become ready");

      await new Promise((r) => setTimeout(r, 40));
    }

    const { result: global } = await send(
      "Runtime.evaluate",
      { expression: "globalThis" },
      sessionId
    );

    const callFunction = async (functionDeclaration, args) => {
      const r = await send(
        "Runtime.callFunctionOn",
        {
          objectId: global.objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          awaitPromise: true,
          returnByValue: true
        },
        sessionId
      );
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));

      return r.result.value;
    };

    return {
      evaluate,
      callFunction,
      close: () => send("Target.closeTarget", { targetId })
    };
  }

  if (extrasOnly) {
    const extra = JSON.parse(await readFile("extra-results.json", "utf8"));
    result.order = {};

    for (const mode of ["native", "dist-chunk"]) {
      activeDir = join(root, "css-order-" + mode, "dist");
      result.order[mode] = {};

      for (const strategy of ["csr", "routeFirst", "dependenciesFirst"]) {
        const tab = await page("/app/index.html", "!!globalThis.routes");
        const files = extra.order[mode][strategy] ?? [];
        result.order[mode][strategy] = await tab.callFunction(
          `async function(files){await Promise.all(files.map(file=>new Promise((resolve,reject)=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/app/'+file;l.onload=resolve;l.onerror=reject;document.head.appendChild(l)})));const a=await routes.a();const el=document.getElementById('target');el.className='order '+a.className;return {background:getComputedStyle(el).backgroundColor,links:[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.getAttribute('href'))}}`,
          [files]
        );
        assert.equal(
          result.order[mode][strategy].background,
          strategy === "routeFirst" ? "rgb(0, 128, 0)" : "rgb(255, 0, 0)",
          `${mode} ${strategy} stylesheet order`
        );
        await tab.close();
      }
    }
  } else {
    for (const mode of ["native", "dist-chunk"]) {
      result.css[mode] = {};
      activeDir = join(root, "css-" + mode, "dist");

      for (const hrefKind of [
        "none",
        "absolute",
        "relative",
        "preload",
        "pending"
      ]) {
        const tab = await page("/app/index.html", "!!globalThis.routes");
        requests = [];
        delayCss = hrefKind === "pending";

        const css = build.css[mode].routeACss;
        const test = await tab.callFunction(
          `async function(kind,css){
        const loaded=[];
        if(kind!=='none')for(const file of css){const link=document.createElement('link');link.rel=kind==='preload'?'preload':'stylesheet';if(kind==='preload')link.as='style';link.href=kind==='relative'?file:'/app/'+file;loaded.push(new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject}));document.head.appendChild(link);}
        if(kind!=='pending')await Promise.all(loaded);
        const t=performance.now();const a=await routes.a();const target=document.getElementById('target');target.className=a.className;
        const importMs=performance.now()-t,colorAtImport=getComputedStyle(target).color;
        await Promise.all(loaded);const colorAfterLoad=getComputedStyle(target).color;
        const transitions=[];for(const name of ['b','a']){const m=await routes[name]();target.className=m.className;transitions.push(getComputedStyle(target).color);}
        const links=[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>({attribute:x.getAttribute('href'),url:x.href}));
        return {importMs,colorAtImport,colorAfterLoad,transitions,links,duplicateStylesheetLinks:links.length-new Set(links.map(x=>x.url)).size};
      }`,
          [hrefKind, css]
        );

        result.css[mode][hrefKind] = { ...test, cssRequests: [...requests] };
        await tab.close();
      }
    }

    delayCss = false;

    const tab = await page("/memo.html", "!!globalThis.probe");
    result.memo.react = await tab.evaluate("probe.version");
    result.memo.correctness = await tab.evaluate("probe.correctness()");

    for (const profile of [
      "stable",
      "fresh-style",
      "fresh-child",
      "changing-variant"
    ]) {
      await tab.callFunction(
        `function(profile){probe.sample('normal',profile,200,30);probe.sample('memo',profile,200,30)}`,
        [profile]
      );

      for (let round = 0; round < 5; round++)
        for (const kind of round % 2
          ? ["memo", "normal"]
          : ["normal", "memo"]) {
          const sample = await tab.callFunction(
            `function(kind,profile){return probe.sample(kind,profile)}`,
            [kind, profile]
          );

          result.memo.samples.push({ round, ...sample });
        }
    }

    await tab.close();
  }

  assert.equal(result.memo.correctness.refAndAs.firstReleased, true);

  for (const m of Object.values(result.css))
    for (const item of Object.values(m))
      assert.deepEqual(item.transitions, ["rgb(0, 0, 255)", "rgb(255, 0, 0)"]);

  await writeFile("browser-results.json", JSON.stringify(result, null, 2));
  console.log("Saved browser-results.json");
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await closed;
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
