import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Real styles and resource requests; no injected CSS loader or mocked imports. */
export async function browserVisits(directory, pages, binary) {
  if (!binary)
    return { skipped: "Set MINCHO_BROWSER_BINARY to run Chromium checks." };

  const root = await realpath(directory);
  const profile = await mkdtemp(join(tmpdir(), "mincho-css-browser-"));
  const requests = [];
  const failures = [];
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname
      );

      if (pathname === "/favicon.ico") {
        response.writeHead(204).end();

        return;
      }

      const path = await realpath(
        resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`)
      );

      const local = relative(root, path);

      assert(
        !isAbsolute(local) && local !== ".." && !local.startsWith("../"),
        "Asset outside fixture"
      );

      requests.push(pathname);

      const type = path.endsWith(".html")
        ? "text/html"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js") || path.endsWith(".mjs")
            ? "text/javascript"
            : "application/octet-stream";

      response.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": path.endsWith(".html")
          ? "no-store"
          : "public, max-age=31536000, immutable"
      });
      response.end(await readFile(path));
    })().catch((error) => {
      failures.push(`${request.url}: ${String(error)}`);
      response.writeHead(404).end();
    });
  });

  try {
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });

    const results = [];

    for (const page of pages) {
      const start = requests.length;
      const { stdout, stderr } = await run(
        binary,
        [
          "--headless",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profile}`,
          "--virtual-time-budget=10000",
          "--dump-dom",
          `http://127.0.0.1:${server.address().port}${page}`
        ],
        { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }
      );

      const match = stdout.match(/<pre id="result">([^<]+)<\/pre>/);

      assert(
        match,
        `Browser fixture did not complete: ${page}\n${stderr}\n${stdout}`
      );

      const result = JSON.parse(match[1].replaceAll("&amp;", "&"));

      assert.equal(result.error, undefined, `Browser error: ${result.error}`);

      for (const phase of result.phases) {
        const expected = {
          initial: "rgb(0, 0, 0)",
          a: "rgb(0, 0, 255)",
          b: "rgb(0, 128, 0)"
        }[phase.name];

        assert.equal(phase.color, expected, `Computed style for ${phase.name}`);
      }

      if (result.phases.length === 4) {
        assert.deepEqual(
          result.phases[3].css,
          result.phases[2].css,
          "Revisiting a route must not fetch CSS again"
        );
      }

      results.push({
        page,
        ...result,
        requests: requests.slice(start),
        cachedCssResources: result.resources.filter(
          (r) => r.name.endsWith(".css") && r.transferSize === 0
        ).length
      });
    }

    assert.deepEqual(failures, []);

    return { visits: results };
  } finally {
    await new Promise((done) => server.close(done));
    await rm(profile, { recursive: true, force: true });
  }
}
