import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildArtifacts } from "./artifacts.js";
import { installedPackageDirectory } from "./artifact-sources.js";
import { reportCssSizes } from "./css-sizes.js";
import { packFixturePackages } from "./fixture-packages.js";
import { packRealProducerPackages } from "./real-producers.js";
import { assertRealBuildArtifacts } from "./real-artifacts.js";
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
  const packedResolutions = Object.fromEntries(
    archives.map((archive) => [
      archive.manifest.name,
      `file:${archive.archivePath}`
    ])
  );

  const dependencies = { ...packedResolutions };
  Object.assign(dependencies, {
    "@vanilla-extract/css": "1.20.1",
    "@vanilla-extract/vite-plugin": "5.2.2",
    esbuild: "0.27.7",
    vite: "7.3.3"
  });
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "mincho-package-contract",
        private: true,
        type: "module",
        packageManager: "yarn@4.18.0",
        dependencies,
        // Yarn resolves transitive semver descriptors separately from root file
        // dependencies. Keep the complete test closure on these exact tarballs.
        resolutions: packedResolutions,
        devDependencies: { typescript: "5.9.3", "@types/node": "25.6.2" }
      },
      null,
      2
    )}\n`
  );
}

async function main(): Promise<void> {
  assertVerifierFailurePaths();

  const tempRoot = await mkdtemp(join(tmpdir(), "mincho-package-contract-"));
  console.log(`[package-contract] temp isolation: ${tempRoot}`);

  try {
    const workspaces = await collectWorkspaceClosure(repoRoot);
    const packed = [
      ...(await packWorkspaceClosure(repoRoot, tempRoot, workspaces)),
      ...(await packFixturePackages(scriptRoot, tempRoot)),
      ...(await packRealProducerPackages(tempRoot))
    ];

    console.log(
      `[package-contract] packed packages: ${packed.map((entry) => entry.manifest.name).join(", ")}`
    );

    for (const linker of ["npm", "pnp"] as const) {
      const consumerRoot = join(tempRoot, linker);
      await mkdir(consumerRoot);
      await writeConsumerManifest(consumerRoot, packed);
      await cp(join(scriptRoot, "fixture"), join(consumerRoot, "fixture"), {
        recursive: true
      });

      const yarnPath = join(repoRoot, ".yarn", "releases", "yarn-4.18.0.cjs");

      if (linker === "pnp") {
        await writeFile(
          join(consumerRoot, ".yarnrc.yml"),
          [
            "nodeLinker: pnp",
            "pnpMode: strict",
            "pnpFallbackMode: none",
            "enableGlobalCache: false",
            "enableScripts: false",
            ""
          ].join("\n")
        );
        await runCommand({
          command: "node",
          args: [yarnPath, "install"],
          cwd: consumerRoot,
          env: { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" }
        });
      } else
        await runCommand({
          command: "npm",
          args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
          cwd: consumerRoot,
          artifactPath: join(consumerRoot, "node_modules")
        });

      await assertInstalledPackageContract({ consumerRoot, packed, repoRoot });

      const runNode = (args: readonly string[], artifactPath: string) =>
        runCommand({
          command: "node",
          args: linker === "pnp" ? [yarnPath, "node", ...args] : args,
          cwd: consumerRoot,
          artifactPath
        });

      await runNode(
        ["fixture/modules/runtime.mjs"],
        join(consumerRoot, "fixture", "modules")
      );
      await runNode(
        [
          join(
            installedPackageDirectory(consumerRoot, "typescript"),
            "bin",
            "tsc"
          ),
          "--project",
          "fixture/modules/tsconfig.json"
        ],
        join(consumerRoot, "fixture", "modules")
      );
      console.log(
        `[package-contract] ${linker}: ESM/CJS imports and strict declarations passed`
      );

      for (const minified of [false, true]) {
        const output = minified ? "dist-minified" : "dist";
        await runNode(
          [
            join(
              installedPackageDirectory(consumerRoot, "vite"),
              "bin",
              "vite.js"
            ),
            "build",
            "--config",
            "fixture/vite/vite.config.ts",
            ...(minified ? ["--minify", "esbuild"] : [])
          ],
          join(consumerRoot, "fixture", "vite", output)
        );
        await runNode(
          ["fixture/esbuild/build.mjs", ...(minified ? ["--minify"] : [])],
          join(consumerRoot, "fixture", "esbuild", output)
        );
        console.log(
          `[package-contract] ${linker}: Vite/esbuild ${output} passed`
        );
      }

      await assertBuildArtifacts({ consumerRoot });
      console.log("[package-contract] artifact assertions: passed");
      await reportCssSizes(consumerRoot);
      await runNode(
        ["fixture/real/build.mjs"],
        join(consumerRoot, "fixture", "real")
      );
      await assertRealBuildArtifacts(consumerRoot);
    }
  } finally {
    if (process.env.MINCHO_KEEP_PACKAGE_CONTRACT !== "1") {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
}

void main();
