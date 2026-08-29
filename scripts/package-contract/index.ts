import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildArtifacts } from "./artifacts.js";
import { packFixturePackages } from "./fixture-packages.js";
import { assertInstalledPackageContract } from "./installed-package-contract.js";
import { runCommand } from "./process.js";
import { assertVerifierFailurePaths } from "./verifier-failures.js";
import { collectWorkspaceClosure, packWorkspaceClosure } from "./workspace.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptRoot, "..", "..");

async function writeConsumerManifest(
  consumerRoot: string,
  archives: readonly {
    readonly archivePath: string;
    readonly manifest: { readonly name: string };
  }[]
): Promise<void> {
  const dependencies = Object.fromEntries(
    archives.map((archive) => [
      archive.manifest.name,
      `file:${archive.archivePath}`
    ])
  );
  Object.assign(dependencies, {
    "@vanilla-extract/css": "1.20.1",
    "@vanilla-extract/vite-plugin": "5.2.2",
    esbuild: "0.27.7",
    vite: "7.3.3"
  });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "mincho-package-contract", private: true, type: "module", dependencies }, null, 2)}\n`
  );
}

async function main(): Promise<void> {
  assertVerifierFailurePaths();
  const consumerRoot = await mkdtemp(
    join(tmpdir(), "mincho-package-contract-")
  );
  console.log(`[package-contract] temp isolation: ${consumerRoot}`);
  try {
    const workspaces = await collectWorkspaceClosure(repoRoot);
    const packed = [
      ...(await packWorkspaceClosure(repoRoot, consumerRoot, workspaces)),
      ...(await packFixturePackages(scriptRoot, consumerRoot))
    ];
    console.log(
      `[package-contract] packed packages: ${packed.map((entry) => entry.manifest.name).join(", ")}`
    );
    await writeConsumerManifest(consumerRoot, packed);
    await cp(join(scriptRoot, "fixture"), join(consumerRoot, "fixture"), {
      recursive: true
    });
    await runCommand({
      command: "npm",
      args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      cwd: consumerRoot,
      artifactPath: join(consumerRoot, "node_modules")
    });
    await assertInstalledPackageContract({ consumerRoot, packed, repoRoot });
    await runCommand({
      command: "node",
      args: [
        join(consumerRoot, "node_modules", "vite", "bin", "vite.js"),
        "build",
        "--config",
        "fixture/vite/vite.config.ts"
      ],
      cwd: consumerRoot,
      artifactPath: join(consumerRoot, "fixture", "vite", "dist")
    });
    console.log("[package-contract] Vite result: production build passed");
    await runCommand({
      command: "node",
      args: ["fixture/esbuild/build.mjs"],
      cwd: consumerRoot,
      artifactPath: join(consumerRoot, "fixture", "esbuild", "dist")
    });
    console.log("[package-contract] esbuild result: production build passed");
    await assertBuildArtifacts({ consumerRoot });
    console.log("[package-contract] artifact assertions: passed");
  } finally {
    if (process.env.MINCHO_KEEP_PACKAGE_CONTRACT !== "1") {
      await rm(consumerRoot, { force: true, recursive: true });
    }
  }
}

void main();
