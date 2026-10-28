import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const doctorPath = require.resolve("@yarnpkg/doctor/cli");
const root = fileURLToPath(new URL("../../", import.meta.url));
const { packageManager } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
);
const yarnPath = join(
  root,
  ".yarn/releases",
  `yarn-${packageManager.slice("yarn@".length)}.cjs`
);

function run(cwd, args) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      YARN_ENABLE_COLORS: "0",
      YARN_ENABLE_PROGRESS_BARS: "0",
      YARN_ENABLE_NETWORK: "0",
      YARN_ENABLE_IMMUTABLE_INSTALLS: "0"
    }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

for (const named of [false, true]) {
  test(`Doctor resolves ${named ? "named" : "default"} catalogs and retains peer checks`, () => {
    const directory = mkdtempSync(join(tmpdir(), "mincho-doctor-catalog-"));
    const writeJson = (path, value) =>
      writeFileSync(
        join(directory, path),
        `${JSON.stringify(value, null, 2)}\n`
      );
    const catalogConfig = named
      ? "catalogs:\n  tools:\n    fixture-tool: 'workspace:*'\n"
      : "catalog:\n  fixture-tool: 'workspace:*'\n";
    const configuration = `nodeLinker: pnp\npnpMode: strict\npnpFallbackMode: none\nyarnPath: ${JSON.stringify(yarnPath)}\n`;
    const manifest = {
      name: "doctor-catalog-consumer",
      private: true,
      packageManager,
      workspaces: ["packages/*"],
      dependencies: {
        "fixture-tool": named ? "catalog:tools" : "catalog:",
        "fixture-peer": "workspace:*"
      }
    };

    try {
      mkdirSync(join(directory, "packages/tool"), { recursive: true });
      mkdirSync(join(directory, "packages/peer"), { recursive: true });
      writeJson("package.json", manifest);
      writeJson("packages/tool/package.json", {
        name: "fixture-tool",
        version: "1.0.0",
        peerDependencies: { "fixture-peer": "^1.0.0" }
      });
      writeJson("packages/peer/package.json", {
        name: "fixture-peer",
        version: "1.0.0"
      });
      writeFileSync(
        join(directory, ".yarnrc.yml"),
        configuration + catalogConfig
      );

      const install = () => {
        const result = run(directory, [
          yarnPath,
          "install",
          "--mode=skip-build"
        ]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
      };
      install();

      const clean = run(directory, [doctorPath, "--json"]);
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      const events = clean.stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      assert.equal(
        events.some((event) => ["warning", "error"].includes(event.type)),
        false
      );
      assert.ok(
        events.some(
          (event) => event.type === "summary" && event.workspaces === 3
        )
      );

      delete manifest.dependencies["fixture-peer"];
      writeJson("package.json", manifest);
      install();
      const missingPeer = run(directory, [doctorPath, "--json"]);
      assert.notEqual(missingPeer.status, 0);
      assert.match(
        missingPeer.stdout,
        /Unmet transitive peer dependency on fixture-peer/
      );

      writeFileSync(
        join(directory, ".yarnrc.yml"),
        configuration + catalogConfig.replace("fixture-tool:", "missing-entry:")
      );
      const missingEntry = run(directory, [doctorPath, "--json"]);
      assert.match(missingEntry.stdout, /entry not found in/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
