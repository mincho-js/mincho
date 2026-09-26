import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const runBrowser = promisify(execFile);

function insideRoot(root: string, path: string): boolean {
  const local = relative(root, path);

  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  );
}

/** Optional real-browser check; the caller selects an installed Chromium binary. */
export async function assertBrowserCss({
  consumerRoot,
  cssFile,
  classes
}: {
  consumerRoot: string;
  cssFile: string;
  classes: { b: string; c: string; d: string; local: string };
}): Promise<void> {
  const binary = process.env.MINCHO_BROWSER_BINARY;

  if (!binary) {
    console.log(
      "[package-contract] browser CSS check skipped: MINCHO_BROWSER_BINARY is unset"
    );

    return;
  }

  const root = await realpath(consumerRoot);
  const stylesheet = await realpath(cssFile);

  assert(
    insideRoot(root, stylesheet),
    "Browser CSS file must be inside consumerRoot"
  );

  const cssUrl = `/${relative(root, stylesheet).split(sep).map(encodeURIComponent).join("/")}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${escapeHtml(cssUrl)}"></head><body>
${Object.entries(classes)
  .map(
    ([id, className]) =>
      `<div id="${id}" class="${escapeHtml(className)}"></div>`
  )
  .join("\n")}
<pre id="result"></pre><script>
window.addEventListener("load", function () {
  var output = {};
  ["b", "c", "d", "local"].forEach(function (id) {
    var style = getComputedStyle(document.getElementById(id));
    output[id] = { color: style.color, padding: style.padding, display: style.display, margin: style.margin };
  });
  document.getElementById("result").textContent = JSON.stringify(output);
});
</script></body></html>`;

  const requestErrors: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET") {
        response.writeHead(405).end();

        return;
      }

      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname
      );

      if (pathname === "/") {
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(html);

        return;
      }

      const requested = resolve(root, `.${pathname}`);

      if (!insideRoot(root, requested)) {
        requestErrors.push(`${request.url}: outside consumerRoot`);
        response.writeHead(403).end();

        return;
      }

      // Also check resolved symlinks before opening a requested asset.
      const actual = await realpath(requested);

      if (!insideRoot(root, actual)) {
        requestErrors.push(`${request.url}: symlink outside consumerRoot`);
        response.writeHead(403).end();

        return;
      }

      const bytes = await readFile(actual);
      response
        .writeHead(200, {
          "Content-Type": actual.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/octet-stream"
        })
        .end(bytes);
    })().catch((error: unknown) => {
      if (request.url !== "/favicon.ico")
        requestErrors.push(`${request.url}: ${String(error)}`);

      response.writeHead(404).end();
    });
  });

  const profile = await mkdtemp(join(tmpdir(), "mincho-browser-"));
  let stdout = "";
  let stderr = "";

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();

    assert(address && typeof address === "object");

    const output = await runBrowser(
      binary,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/`
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024
      }
    );

    stdout = output.stdout;
    stderr = output.stderr;

    const result = stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];

    assert(result, "Chromium did not report computed styles");

    const styles = JSON.parse(result) as Record<
      string,
      { color: string; padding: string; display: string; margin: string }
    >;

    for (const id of ["b", "c"]) {
      assert.equal(styles[id]?.color, "rgb(255, 0, 0)", `${id} color`);
      assert.equal(styles[id]?.padding, "4px", `${id} padding`);
    }

    assert.equal(styles.d?.padding, "4px", "d padding");
    assert.equal(styles.d?.display, "grid", "d display");
    assert.equal(styles.local?.margin, "2px", "local margin");
    assert.deepEqual(requestErrors, [], "Browser resource requests failed");

    console.log(
      `[package-contract] browser computed styles passed: ${relative(root, stylesheet)}`
    );
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };

    throw new Error(
      `Browser CSS check failed: ${String(error)}\nRequests: ${JSON.stringify(requestErrors)}\nChromium stderr:\n${failure.stderr ?? stderr}\nDOM:\n${failure.stdout ?? stdout}`,
      { cause: error }
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}
