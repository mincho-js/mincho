import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { CHECK_MARKER } from "./github.js";

test("the Node action edits the status and writes outputs when run outside a checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fast-forward-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const head = "a".repeat(40);
  const calls = [];
  let body = CHECK_MARKER + "\nprevious check";
  const server = createServer(async (request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("/pulls/42")) {
      response.end(
        JSON.stringify({
          number: 42,
          state: "open",
          base: { ref: "main" },
          head: { ref: "feature", sha: head }
        })
      );
    } else if (request.method === "GET") {
      response.end(
        JSON.stringify([
          { id: 123, body, user: { login: "github-actions[bot]", type: "Bot" } }
        ])
      );
    } else if (
      request.method === "PATCH" &&
      request.url.endsWith("/issues/comments/123")
    ) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString()).body;
      response.end(JSON.stringify({ id: 123, body }));
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: "unexpected request" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const eventPath = join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: { number: 42 },
      sender: { login: "maintainer" }
    })
  );
  // Git behavior is exercised against real local repositories in git.test.js.
  // Here it is deterministic so the actual entry point can use a local API.
  await writeFile(
    join(directory, "git"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MINCHO_TEST_GIT_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'rev-parse') console.log((args[1].endsWith('/base') ? 'b' : 'a').repeat(40));
if (args[0] === 'push') process.exit(1);
`,
    { mode: 0o755 }
  );
  for (const run of [1, 2]) {
    const output = join(directory, `output-${run}`);
    const summary = join(directory, `summary-${run}`);
    const result = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("./index.js", import.meta.url))],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MINCHO_TEST_GIT_LOG: join(directory, "git-calls.jsonl"),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
          GITHUB_SERVER_URL: "https://github.example",
          GITHUB_RUN_ID: String(run),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INPUT_GITHUB_TOKEN: "fake-token",
          INPUT_MERGE: "false",
          INPUT_COMMENT: "always"
        }
      }
    );
    assert.equal(result.stderr, "");
    const outputs = await readFile(output, "utf8");
    assert.match(outputs, /merged=false/);
    assert.equal(JSON.parse(outputs.split("\n")[1]).body, body);
    assert.equal(await readFile(summary, "utf8"), body + "\n");
    assert.doesNotMatch(outputs, /fake-token/);
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === "PATCH").map((call) => call.url),
    [
      "/repos/owner/repo/issues/comments/123",
      "/repos/owner/repo/issues/comments/123"
    ]
  );
  assert.match(body, /actions\/runs\/2/);
});
