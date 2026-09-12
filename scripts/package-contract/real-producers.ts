import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRules, type DefineRulesPresetArtifactV5 } from "@mincho-js/css";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession,
  parseDefineRulesPresetArtifactV5,
  resolveDefineRulesPresetGraphV5
} from "@mincho-js/css/defineRules/registry";
import {
  setAdapter,
  removeAdapter,
  mockAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import { transformCss } from "@vanilla-extract/css/transformCss";
import { runCommand } from "./process.js";
import type { PackedPackage, WorkspacePackage } from "./types.js";
import { readPackageManifest } from "./workspace.js";

export const realProducerPackageNames = [
  "@mincho-js-proof/real-a",
  "@mincho-js-proof/real-b",
  "@mincho-js-proof/real-c",
  "@mincho-js-proof/real-d"
] as const;

interface RealProducer {
  readonly packageName: string;
  readonly ancestorPackages: readonly string[];
  readonly preset: DefineRulesPresetArtifactV5;
  readonly className: string;
  readonly css: string;
}

/** Execute the public API and let vanilla-extract serialize its actual CSS. */
function generateRealProducers(): readonly RealProducer[] {
  const specifications = [
    { parents: [], style: { padding: 4 } },
    { parents: [0], style: { padding: 4, color: "red" } },
    { parents: [0], style: { padding: 4, color: "red" } },
    { parents: [1, 2], style: { padding: 4, color: "red", display: "grid" } }
  ] as const;

  const producers: RealProducer[] = [];
  beginDefineRulesRegistrySession();

  try {
    for (const [index, specification] of specifications.entries()) {
      const packageName = realProducerPackageNames[index];
      const parents = specification.parents.map((parent) => producers[parent]);
      const cssInput: Parameters<typeof transformCss>[0] = {
        localClassNames: [],
        composedClassLists: [],
        cssObjs: []
      };

      setAdapter({
        ...mockAdapter,

        appendCss: (css) => cssInput.cssObjs.push(css),

        registerClassName: (className) =>
          cssInput.localClassNames.push(className),

        registerComposition: (composition) =>
          cssInput.composedClassLists.push(composition),

        getIdentOption: () => "debug"
      });

      try {
        setFileScope("src/index.css.ts", packageName);

        try {
          const rules = defineRules({
            debugId: `real_${String.fromCharCode(97 + index)}`,
            properties: { padding: true, color: true, display: true },
            presets: parents.map((parent) => parent.preset)
          });

          const className = rules.css(specification.style);
          const preset = rules.preset;

          // Parse the produced artifact to verify the published V5 hash contract.
          const graph = resolveDefineRulesPresetGraphV5([
            parseDefineRulesPresetArtifactV5(preset)
          ]);

          producers.push({
            packageName,
            ancestorPackages: graph.styleOrigins.filter(
              (origin) => origin !== packageName
            ),
            preset,
            className,
            css: [...transformCss(cssInput), ""].join("\n")
          });
        } finally {
          endFileScope();
        }
      } finally {
        removeAdapter();
      }
    }
  } finally {
    endDefineRulesRegistrySession();
  }

  const [a, b, c, d] = producers;

  const localAtoms = (producer: RealProducer) =>
    producer.preset.nodes.find(
      (node) => node.nodeId === producer.preset.rootNodeId
    )!.atoms;

  const bColor = localAtoms(b).find((atom) => atom.property === "color")!;
  const cColor = localAtoms(c).find((atom) => atom.property === "color")!;

  assert.equal(
    bColor.atomId,
    cColor.atomId,
    "B/C must independently register the same CSS atom"
  );
  assert.notEqual(
    bColor.className,
    cColor.className,
    "Both independently emitted classes must remain valid"
  );
  assert.ok(localAtoms(a).some((atom) => atom.property === "padding"));
  assert.ok(localAtoms(b).every((atom) => atom.property !== "padding"));
  assert.ok(localAtoms(c).every((atom) => atom.property !== "padding"));

  const graph = resolveDefineRulesPresetGraphV5([
    parseDefineRulesPresetArtifactV5(d.preset)
  ]);

  assert.ok(graph.atomIdByClassName.has(bColor.className));
  assert.ok(graph.atomIdByClassName.has(cColor.className));
  assert.equal(graph.atomById.get(bColor.atomId)?.className, cColor.className);
  assert.deepEqual(graph.styleOrigins, realProducerPackageNames);

  return producers;
}

export async function createRealProducerPackages(
  tempRoot: string
): Promise<readonly WorkspacePackage[]> {
  const cssManifest = await readPackageManifest(
    fileURLToPath(new URL("../../packages/css/package.json", import.meta.url))
  );

  const producers = generateRealProducers();
  const packages: WorkspacePackage[] = [];

  for (const producer of producers) {
    const directory = join(
      tempRoot,
      "real-producers",
      ...producer.packageName.split("/")
    );

    const dist = join(directory, "dist");
    await mkdir(dist, { recursive: true });

    const manifestPath = join(directory, "package.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: producer.packageName,
          version: "0.0.0",
          type: "module",
          sideEffects: ["./dist/style.css"],
          dependencies: {
            "@mincho-js/css": cssManifest.version,
            ...Object.fromEntries(
              producer.ancestorPackages.map((ancestor) => [ancestor, "0.0.0"])
            )
          },
          peerDependencies: { "@vanilla-extract/css": "^1.20.1" },
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./preset": {
              types: "./dist/preset.d.ts",
              default: "./dist/preset.js"
            },
            "./style.css": "./dist/style.css"
          },
          files: ["dist"]
        },
        null,
        2
      )}\n`
    );
    await Promise.all([
      writeFile(
        join(dist, "index.js"),
        [
          ...producer.ancestorPackages.map(
            (ancestor) => `import ${JSON.stringify(`${ancestor}/style.css`)};`
          ),
          'import "./style.css";',
          `export const className = ${JSON.stringify(producer.className)};`,
          ""
        ].join("\n")
      ),
      writeFile(
        join(dist, "index.d.ts"),
        "export declare const className: string;\n"
      ),
      writeFile(
        join(dist, "preset.js"),
        `export const preset = ${JSON.stringify(producer.preset)};\n`
      ),
      writeFile(
        join(dist, "preset.d.ts"),
        'import type { DefineRulesPresetArtifactV5 } from "@mincho-js/css";\nexport declare const preset: DefineRulesPresetArtifactV5;\n'
      ),
      writeFile(join(dist, "style.css"), producer.css)
    ]);
    packages.push({
      directory,
      manifest: await readPackageManifest(manifestPath)
    });
  }

  return packages;
}

export async function packRealProducerPackages(
  tempRoot: string
): Promise<readonly PackedPackage[]> {
  const packages = await createRealProducerPackages(tempRoot);
  const packed: PackedPackage[] = [];

  for (const producer of packages) {
    const archiveDirectory = join(
      tempRoot,
      "packed-real-producers",
      producer.manifest.name.replace(/[@/]/g, "-")
    );

    await mkdir(archiveDirectory, { recursive: true });
    await runCommand({
      command: "npm",
      args: [
        "pack",
        producer.directory,
        "--pack-destination",
        archiveDirectory
      ],
      cwd: tempRoot,
      artifactPath: producer.directory
    });

    const archives = (await readdir(archiveDirectory)).filter((path) =>
      path.endsWith(".tgz")
    );

    assert.equal(
      archives.length,
      1,
      `Expected one packed real producer: ${producer.manifest.name}`
    );

    packed.push({
      ...producer,
      archivePath: join(archiveDirectory, archives[0])
    });
  }

  return packed;
}
