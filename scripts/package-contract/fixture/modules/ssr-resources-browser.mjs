import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export async function verifySsrBrowser({ root, manifest, streaming }) {
  const binary = process.env.MINCHO_BROWSER_BINARY;

  if (!binary) {
    console.log(
      "[package-contract] SSR browser check skipped: MINCHO_BROWSER_BINARY is unset"
    );

    return;
  }

  let delayed = false;
  let failures = 0;
  let lateFailures = 0;
  const requests = [];
  const bOnly = manifest.routes.b.filter(
    (file) => !manifest.routes.a.includes(file)
  );

  assert.ok(bOnly.length);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();

        return;
      }

      if (
        [
          "/app/failure.css",
          "/app/concurrent.css",
          "/app/prefetched.css",
          "/app/aborted.css",
          "/app/late-error.css"
        ].includes(url.pathname)
      ) {
        requests.push(url.pathname);

        if (url.pathname === "/app/late-error.css" && lateFailures++ === 0) {
          res.writeHead(500, { "Cache-Control": "no-store" }).end();

          return;
        }

        if (url.pathname === "/app/failure.css" && failures++ === 0) {
          res.writeHead(500, { "Cache-Control": "no-store" }).end();

          return;
        }

        await new Promise((r) => setTimeout(r, 100));
        res
          .writeHead(200, {
            "Content-Type": "text/css",
            "Cache-Control": "public, max-age=600"
          })
          .end(".preload-ready{padding:11px}.recovered{color:rgb(1, 2, 3)}");

        return;
      }

      if (url.pathname === "/app/stream") {
        res.setHeader("Content-Type", "text/html");

        for (const part of streaming) {
          res.write(part);
          await new Promise((r) => setTimeout(r, 40));
        }

        res.end();

        return;
      }

      const path = resolve(
        root,
        decodeURIComponent(url.pathname.replace(/^\/app\//, ""))
      );

      const local = relative(root, path);

      if (local.startsWith("..") || isAbsolute(local)) {
        res.writeHead(403).end();

        return;
      }

      const source = await readFile(path);

      if (path.endsWith(".css")) {
        requests.push(url.pathname);

        if (delayed && bOnly.some((file) => url.pathname.endsWith(file)))
          await new Promise((r) => setTimeout(r, 250));
      }

      res.setHeader(
        "Content-Type",
        path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : "text/html"
      );
      res.setHeader("Cache-Control", "public, max-age=600");
      res.end(source);
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), "mincho-ssr-chrome-"));
  const child = spawn(
    binary,
    [
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  const closed = new Promise((r) => {
    child.once("exit", r);
    child.once("error", r);
  });
  let socket,
    serial = 0;

  const pending = new Map();
  const browserErrors = [];

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method} ${params.expression ?? ""}`));
      }, 20000);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },

        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
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
    const endpoint = await new Promise((r, j) => {
      let text = "";
      const timeout = setTimeout(
        () => j(Error("Chromium startup timeout")),
        15000
      );

      child.once("error", (e) => {
        clearTimeout(timeout);
        j(e);
      });
      child.stderr.on("data", (data) => {
        text += data;

        const match = text.match(/DevTools listening on (ws:\/\/\S+)/);

        if (match) {
          clearTimeout(timeout);
          r(match[1]);
        }
      });
    });

    socket = new WebSocket(endpoint);
    await new Promise((r, j) => {
      socket.addEventListener("open", r, { once: true });
      socket.addEventListener("error", j, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data),
        p = pending.get(m.id);

      if (m.method === "Runtime.exceptionThrown")
        browserErrors.push(
          m.params.exceptionDetails.exception?.description ??
            m.params.exceptionDetails.text
        );
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
        browserErrors.push(m.params.entry.text);

      if (p) {
        pending.delete(m.id);
        m.error
          ? p.reject(Error(JSON.stringify(m.error)))
          : p.resolve(m.result);
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
        throw Error(JSON.stringify(result.exceptionDetails));

      return result.result.value;
    };

    async function until(expression) {
      const deadline = Date.now() + 15000;

      while (!(await evaluate(expression))) {
        if (Date.now() > deadline)
          throw Error(`Browser timeout: ${expression}`);

        await new Promise((r) => setTimeout(r, 25));
      }
    }

    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send("Page.navigate", { url: origin + "/app/index.html" }, sessionId);
    await until("!!globalThis.switchPage && commits.length>0");

    assert.equal(
      await evaluate(
        "getComputedStyle(document.getElementById('target')).backgroundColor"
      ),
      "rgb(255, 0, 0)",
      "SSR/CSR cascade order"
    );
    assert.deepEqual(await evaluate("hydrationErrors"), []);
    assert.deepEqual(await evaluate("verifyMemo()"), {
      stableCalls: 1,
      firstTag: "BUTTON",
      tag: "A",
      padding: "8px",
      href: "/link",
      mutableClass: "after"
    });

    // Emulate a streaming-inserted stylesheet which the Vite import helper can
    // discover before load. The route handoff must delay the new content's commit.
    delayed = true;
    await evaluate(
      `for(const file of ${JSON.stringify(bOnly)}){const link=document.createElement('link');link.rel='stylesheet';link.href=file;link.crossOrigin='';document.head.appendChild(link)};void switchPage('b');`
    );
    await until("commits.some(x=>x.route==='b')");
    await evaluate("void switchPage('a')");
    await until("commits.filter(x=>x.route==='a').length===2");

    const commits = await evaluate("commits");

    assert.deepEqual(
      commits.map((x) => [x.route, x.color]),
      [
        ["a", "rgb(255, 0, 0)"],
        ["b", "rgb(0, 0, 255)"],
        ["a", "rgb(255, 0, 0)"]
      ],
      "content committed before its stylesheet loaded"
    );

    const links = await evaluate(
      "[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href)"
    );

    assert.equal(
      new Set(links).size,
      links.length,
      "duplicate stylesheet DOM links"
    );
    assert.equal(
      new Set(requests).size,
      requests.length,
      "duplicate stylesheet requests"
    );

    const helper = await evaluate(`(async()=>{
      const link=href=>[{rel:'stylesheet',href:'/app/'+href,crossOrigin:''}];
      await Promise.all([loadStylesheets(link('concurrent.css')),loadStylesheets(link('concurrent.css'))]);
      const pre=document.createElement('link');pre.rel='preload';pre.as='style';pre.crossOrigin='';pre.href='/app/prefetched.css';await new Promise((r,j)=>{pre.onload=r;pre.onerror=j;document.head.appendChild(pre)});
      await loadStylesheets(link('prefetched.css'));
      const probe=document.createElement('div');probe.className='preload-ready recovered';document.body.appendChild(probe);
      let failed=false;try{await loadStylesheets(link('failure.css'))}catch(error){failed=error.message.includes('failure.css')}
      await loadStylesheets(link('failure.css'));
      const controller=new AbortController();const aborted=loadStylesheets(link('aborted.css'),{signal:controller.signal}).then(()=>false,e=>e.name==='AbortError');const shared=loadStylesheets(link('aborted.css'));controller.abort();await shared;
      const old=document.createElement('link');old.rel='stylesheet';old.href='/app/late-error.css';await new Promise(r=>{old.onerror=r;document.head.appendChild(old)});performance.clearResourceTimings();let lateRejected=false;try{await loadStylesheets(link('late-error.css'),{timeoutMs:20})}catch(e){lateRejected=e.message.includes('late-error.css')}await loadStylesheets(link('late-error.css'));
      return {failed,lateRejected,aborted:await aborted,padding:getComputedStyle(probe).padding,color:getComputedStyle(probe).color,links:[...document.querySelectorAll('link[rel=stylesheet]')].map(x=>x.href)};
    })()`);

    assert.equal(helper.failed, true);
    assert.equal(helper.lateRejected, true);
    assert.equal(helper.aborted, true);
    assert.equal(helper.padding, "11px");
    assert.equal(helper.color, "rgb(1, 2, 3)");
    assert.equal(new Set(helper.links).size, helper.links.length);

    for (const file of ["concurrent.css", "prefetched.css", "aborted.css"])
      assert.equal(
        requests.filter((path) => path === "/app/" + file).length,
        1,
        file
      );

    assert.equal(
      requests.filter((path) => path === "/app/failure.css").length,
      2,
      "explicit retry"
    );

    await send("Network.enable", {}, sessionId);
    await send("Network.clearBrowserCache", {}, sessionId);
    await send("Page.navigate", { url: origin + "/app/stream" }, sessionId);
    await until(
      "!!document.getElementById('stream-ready') && !document.getElementById('stream-fallback')"
    );

    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('#stream-ready .order')).backgroundColor"
      ),
      "rgb(0, 0, 255)"
    );

    console.log(
      "[package-contract] browser SSR/hydration, pending CSS, a→b→a, explicit memo and streaming passed"
    );
  } catch (error) {
    console.error(JSON.stringify({ browserErrors, requests }, null, 2));

    throw error;
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    await closed;
    await new Promise((r) => server.close(r));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50
    });
  }
}
