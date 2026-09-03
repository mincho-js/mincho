import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDecision, reviewDoctor } from "./report.mjs";

function main() {
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--version")) {
    throw new Error(
      "Use yarn doctor for the full checked scan, or yarn doctor:raw for upstream options"
    );
  }
  const versionOnly = args.length === 1;
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@yarnpkg/doctor/cli"),
      ...(versionOnly ? args : ["--json"])
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        YARN_ENABLE_COLORS: "0",
        YARN_ENABLE_PROGRESS_BARS: "0"
      }
    }
  );
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (versionOnly) {
    process.stdout.write(result.stdout);
    process.exitCode = result.status ?? 1;
  } else {
    const exceptions = JSON.parse(
      readFileSync(new URL("./exceptions.json", import.meta.url), "utf8")
    );
    const { failures, accepted, summary, decisions } = reviewDoctor({
      ...result,
      root,
      exceptions,
      readSource: (file) => readFileSync(resolve(root, file), "utf8")
    });
    for (const decision of decisions) {
      const stream =
        decision.kind === "ALLOW" ? process.stdout : process.stderr;
      stream.write(`[doctor] ${formatDecision(decision)}\n`);
    }
    const totals = [
      "ALLOW",
      "NEW",
      "EXPIRED",
      "STALE",
      "AMBIGUOUS",
      "BROAD",
      "ERROR"
    ]
      .map(
        (kind) =>
          `${kind}=${decisions.filter((decision) => decision.kind === kind).length}`
      )
      .join(" ");
    process.stdout.write(`[doctor] ${totals}\n`);
    process.stdout.write(
      `[doctor] ${summary?.workspaces ?? 0} workspaces, ${summary?.files ?? 0} files; ${accepted} diagnostics matched explicit exceptions in scripts/doctor/exceptions.json.\n`
    );
    process.stdout.write(
      `[doctor] ${failures.length ? "FAIL" : "PASS"}: ${failures.length} unreviewed diagnostics or invalid exceptions. Use yarn doctor:raw to see the upstream report.\n`
    );
    process.exitCode = failures.length ? 1 : 0;
  }
}

try {
  main();
} catch (error) {
  const kind = error.code === "AMBIGUOUS" ? "AMBIGUOUS" : "ERROR";
  process.stderr.write(`[doctor] ${kind} ${error.message}\n`);
  process.exitCode = 2;
}
