import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession,
  getActiveDefineRulesRegistrySession,
  parseDefineRulesPresetArtifactV5,
  type DefineRulesRegistrySession
} from "@mincho-js/css/defineRules/registry";
import { defineRules } from "@mincho-js/css";
import { processVanillaFile } from "@vanilla-extract/integration";
import {
  getConfigEntry,
  validateSerializableConfigEntry
} from "./defineRulesPresetValidation.js";

type Awaitable<Value> = Value | PromiseLike<Value>;

let defineRulesPresetRegistryQueue: Promise<void> = Promise.resolve();

export type DefineRulesPresetRegistryFileOptions = Parameters<
  typeof processVanillaFile
>[0];

export interface DefineRulesPresetRegistryResult {
  source: string;
  registrySession: DefineRulesRegistrySession;
  ancestorStyleSpecifiers: readonly string[];
}

export function getDefineRulesAncestorStyleSpecifiers(
  registrySession: DefineRulesRegistrySession
): string[] {
  return getDefineRulesAncestorStyleSpecifiersFromArtifacts(
    registrySession.instances.map((instance) => instance.getPresetSnapshot())
  );
}

function getOriginPackage(origin: string): string {
  const separator = origin.indexOf(":");
  if (separator === -1) {
    throw new TypeError(
      `defineRules preset origin is missing a package separator: ${origin}`
    );
  }
  return origin.slice(0, separator);
}

function getDefineRulesAncestorStyleSpecifiersFromArtifacts(
  artifacts: readonly ReturnType<typeof parseDefineRulesPresetArtifactV5>[]
): string[] {
  const specifiers: string[] = [];
  const packages = new Set<string>();

  for (const artifact of artifacts) {
    const nodes = new Map(
      artifact.nodes.map((node) => [node.nodeId, node] as const)
    );
    const visited = new Set<typeof artifact.rootNodeId>();
    const root = nodes.get(artifact.rootNodeId);

    if (root === undefined) {
      throw new TypeError("defineRules preset root node is missing");
    }

    const localPackage = getOriginPackage(root.origin);
    const visit = (nodeId: typeof artifact.rootNodeId): void => {
      if (visited.has(nodeId)) return;
      const node = nodes.get(nodeId);

      if (node === undefined) {
        throw new TypeError(
          `defineRules preset parent node is missing: ${nodeId}`
        );
      }

      visited.add(nodeId);
      for (const parentId of node.parents) visit(parentId);

      const packageSpecifier = getOriginPackage(node.origin);
      if (
        packageSpecifier !== localPackage &&
        !packages.has(packageSpecifier)
      ) {
        packages.add(packageSpecifier);
        specifiers.push(`${packageSpecifier}/style.css`);
      }
    };

    visit(artifact.rootNodeId);
  }

  return specifiers;
}

export function runDefineRulesPresetRegistryStep<Result>(
  step: () => Awaitable<Result>
): Promise<Result> {
  const queuedStep = defineRulesPresetRegistryQueue
    .catch(() => undefined)
    .then(step);

  defineRulesPresetRegistryQueue = queuedStep.then(
    () => undefined,
    () => undefined
  );

  return queuedStep;
}

export async function processDefineRulesPresetRegistryFile(
  options: DefineRulesPresetRegistryFileOptions
): Promise<DefineRulesPresetRegistryResult> {
  const registrySession = beginDefineRulesRegistrySession();

  try {
    const source = await processVanillaFile(options);
    const presetArtifacts =
      validateDefineRulesRegistrySessionArtifacts(registrySession);

    return {
      source,
      registrySession,
      ancestorStyleSpecifiers:
        getDefineRulesAncestorStyleSpecifiersFromArtifacts(presetArtifacts)
    };
  } finally {
    endDefineRulesRegistrySession();
  }
}

export function validateDefineRulesRegistrySession(
  registrySession: DefineRulesRegistrySession
): void {
  validateDefineRulesRegistrySessionArtifacts(registrySession);
}

function validateDefineRulesRegistrySessionArtifacts(
  registrySession: DefineRulesRegistrySession
): ReturnType<typeof parseDefineRulesPresetArtifactV5>[] {
  return registrySession.instances.map((instance) => {
    const artifact = parseDefineRulesPresetArtifactV5(
      instance.getPresetSnapshot()
    );
    const diagnosticContext = {
      fileScope: instance.fileScope,
      registrationIndex: instance.registrationIndex
    };

    validateSerializableConfigEntry(
      getConfigEntry(instance.config, "conditions"),
      "config.conditions",
      diagnosticContext
    );
    validateSerializableConfigEntry(
      getConfigEntry(instance.config, "properties"),
      "config.properties",
      diagnosticContext
    );
    validateSerializableConfigEntry(
      getConfigEntry(instance.config, "shortcuts"),
      "config.shortcuts",
      diagnosticContext
    );
    validateSerializableConfigEntry(
      getConfigEntry(instance.config, "context"),
      "config.context",
      diagnosticContext,
      { validatePlainSerializableValues: true }
    );
    return artifact;
  });
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, afterEach, vi } = import.meta.vitest;

  const normalizeSource = (source: string) => source.replace(/\s+/g, "");

  let fixtureIndex = 0;

  afterEach(() => {
    while (getActiveDefineRulesRegistrySession() != null) {
      endDefineRulesRegistrySession();
    }
  });

  function createDeferred<Value>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });

    return {
      promise,
      resolve,
      reject
    };
  }

  function createRegistryFixturePath(label: string): string {
    fixtureIndex += 1;
    return `${process.cwd()}/packages/integration/src/__fixtures__/defineRulesPreset-registry-${fixtureIndex}-${label}.css.ts`;
  }

  async function compileRegistryFixture(
    source: string,
    label: string,
    filePath = createRegistryFixturePath(label)
  ) {
    const { compile } = await import("./compile.js");
    const compiled = await compile({
      filePath,
      originalPath: filePath,
      contents: source,
      resolverCache: new Map()
    });

    return {
      filePath,
      source: compiled.source
    };
  }

  async function processRegistryFixture(
    source: string,
    label: string,
    filePath?: string
  ) {
    const compiled = await compileRegistryFixture(source, label, filePath);
    const emittedCssSources: string[] = [];
    const result = await processDefineRulesPresetRegistryFile({
      source: compiled.source,
      filePath: compiled.filePath,
      identOption: "debug",
      serializeVirtualCssPath: ({ fileName, source }) => {
        emittedCssSources.push(source);
        return `import "${fileName}";`;
      }
    });

    return {
      ...result,
      emittedCss: emittedCssSources.join("\n")
    };
  }

  async function evaluateRegistryFixtureBeforeExportSerialization(
    source: string,
    label: string,
    filePath: string
  ): Promise<DefineRulesRegistrySession> {
    const compiled = await compileRegistryFixture(source, label, filePath);
    const registrySession = beginDefineRulesRegistrySession();

    try {
      try {
        await processVanillaFile({
          source: compiled.source,
          filePath: compiled.filePath,
          identOption: "debug"
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Invalid exports")
        ) {
          return registrySession;
        }

        throw error;
      }

      return registrySession;
    } finally {
      endDefineRulesRegistrySession();
    }
  }

  function createRegistrySession(config: unknown): DefineRulesRegistrySession {
    const presetArtifact = defineRules({ properties: {} }).preset;
    return {
      instances: [
        {
          registrationId: "test:registry.css.ts#defineRules:0",
          fileScope: {
            packageName: "test",
            filePath: "registry.css.ts"
          },
          registrationIndex: 0,
          config,
          presetArtifact,
          getPresetSnapshot: () => presetArtifact
        }
      ],
      nextRegistrationIndex: 1,
      nextRegistrationIndexByFileScope: {
        "test:registry.css.ts": 1
      }
    } as unknown as DefineRulesRegistrySession;
  }

  type RegistryFixtureEvaluation = "serialized" | "not-serialized";

  interface RegistryFixtureCase {
    caseId: string;
    expectedEvaluation: RegistryFixtureEvaluation;
    expectedRegistryInstances: number;
    expectedSourceSnippets: readonly string[];
    relativePath: string;
    fixturePath: string;
  }

  interface DefineRulesPresetSerializationManifest {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: {
      readonly packageDiamond: string;
      readonly packageDiamondReversed: string;
      readonly packageDiamondDuplicate: string;
      readonly packageDiamondDist: string;
      readonly packageDiamondDistCss: string;
      readonly packageDiamondReversedDist: string;
      readonly packageDiamondReversedDistCss: string;
      readonly packageDiamondA: string;
      readonly packageDiamondACss: string;
      readonly packageDiamondB: string;
      readonly packageDiamondBCss: string;
      readonly packageDiamondC: string;
      readonly packageDiamondCCss: string;
    };
    DEFINE_RULES_PRESET_SERIALIZATION_PACKAGE_DIAMOND_FAILURE_CASES: readonly {
      readonly caseId: string;
      readonly expectedDiagnostic: string;
      readonly relativePath: string;
    }[];
    DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly Omit<
      RegistryFixtureCase,
      "fixturePath"
    >[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  }

  const expectedRegistryFixtureCaseIds = [
    "registry-direct-exported-owner",
    "registry-exported-destructured",
    "registry-helper-wrapped-executed",
    "registry-iife-executed",
    "registry-nested-function-executed",
    "registry-helper-invoked-twice",
    "registry-multiple-instances",
    "registry-imported-helper-executed",
    "registry-const-config-executed",
    "registry-context-serializable",
    "registry-exported-factory-not-executed",
    "registry-function-config-invalid"
  ];

  function getDefineRulesPresetSerializationManifestUrl(): string {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
    const importMetaUrl = import.meta.url;

    return new URL(
      "./__fixtures__/defineRules-preset-serialization/manifest.ts",
      importMetaUrl
    ).href;
  }

  async function loadDefineRulesPresetSerializationManifest(): Promise<DefineRulesPresetSerializationManifest> {
    return (await import(
      getDefineRulesPresetSerializationManifestUrl()
    )) as DefineRulesPresetSerializationManifest;
  }

  async function getDefineRulesPresetSerializationFixturePath(
    relativePath: string
  ): Promise<string> {
    const manifest = await loadDefineRulesPresetSerializationManifest();

    return manifest.createDefineRulesPresetSerializationFixturePath(
      relativePath
    );
  }

  async function loadRegistryFixtureMatrixCases(): Promise<
    RegistryFixtureCase[]
  > {
    const manifest = await loadDefineRulesPresetSerializationManifest();

    return manifest.DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.map(
      (fixtureCase) => ({
        ...fixtureCase,
        fixturePath: manifest.createDefineRulesPresetSerializationFixturePath(
          fixtureCase.relativePath
        )
      })
    );
  }

  async function readRegistryFixtureSource(
    fixturePath: string
  ): Promise<string> {
    const fs = await import("node:fs/promises");

    return fs.readFile(fixturePath, "utf8");
  }

  async function readDefineRulesPresetSerializationFixture(
    relativePath: string
  ): Promise<string> {
    return readRegistryFixtureSource(
      await getDefineRulesPresetSerializationFixturePath(relativePath)
    );
  }

  async function listFixtureFiles(rootPath: string): Promise<string[]> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const files: string[] = [];

    for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
      const entryPath = path.join(rootPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await listFixtureFiles(entryPath)));
      } else {
        files.push(entryPath);
      }
    }

    return files;
  }

  function extractExportedPresetArtifact(
    source: string,
    exportName = "preset"
  ): DefineRulesPresetArtifact {
    const pattern = new RegExp(
      `export const ${exportName} = (\\{.*?\\});`,
      "s"
    );
    const match = pattern.exec(source);

    if (match?.[1] === undefined) {
      throw new Error(`Fixture is missing exported ${exportName} V5 preset`);
    }

    return parseDefineRulesPresetArtifactV5(JSON.parse(match[1]));
  }

  function resolvePackageDiamondFixtureSpecifiers(source: string): string {
    return source.replace(
      /"@mincho-js-proof\/([^"]+)"/g,
      '"../node_modules/@mincho-js-proof/$1/dist/index.js"'
    );
  }

  function normalizeRegistryFixtureSource(source: string): string {
    return source.replace(/\s+/g, " ").trim();
  }

  function expectSerializedMarkerClassName(
    source: string,
    bindingName: string,
    expectedClassName: string
  ): void {
    const match = new RegExp(`\\b${bindingName} = '([^']*)'`).exec(source);

    if (match === null || match[1] === undefined) {
      throw new Error(`Missing serialized class binding ${bindingName}`);
    }

    const tokens = match[1].split(/\s+/).filter(Boolean);
    const markers = tokens.filter((token) => token.startsWith("__mincho_seg_"));
    const classNames = tokens.filter(
      (token) => !token.startsWith("__mincho_seg_")
    );

    expect(markers).toHaveLength(1);
    expect(classNames.join(" ")).toBe(expectedClassName);
  }

  function expectSourceToContainSnippet(source: string, snippet: string): void {
    expect(normalizeRegistryFixtureSource(source)).toContain(
      normalizeRegistryFixtureSource(snippet)
    );
  }

  async function expectRegistryFixtureToRejectWithDiagnostic({
    caseId,
    expectedPath,
    relativePath
  }: {
    caseId: string;
    expectedPath: string;
    relativePath: string;
  }): Promise<void> {
    const fixturePath =
      await getDefineRulesPresetSerializationFixturePath(relativePath);
    const fixtureSource = await readRegistryFixtureSource(fixturePath);
    let thrownError: unknown;

    try {
      await processRegistryFixture(fixtureSource, caseId, fixturePath);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    const message = (thrownError as Error).message;
    expect(message).toContain(
      `defineRules registry serialization does not support non-serializable context at ${expectedPath}`
    );
    expect(message).toContain("fileScope:");
    expect(message).toContain("registrationIndex: 0");
  }

  function collectPresetClassNames(
    registrySession: DefineRulesRegistrySession
  ): string[] {
    return [
      ...new Set(
        registrySession.instances.flatMap((instance) =>
          instance.presetArtifact.nodes.flatMap((node) =>
            node.atoms.map((atom) => atom.className)
          )
        )
      )
    ];
  }

  function expectRegistryInstancesToHavePresetAtoms(
    registrySession: DefineRulesRegistrySession
  ): void {
    for (const instance of registrySession.instances) {
      expect(
        instance.presetArtifact.nodes.flatMap((node) => node.atoms).length
      ).toBeGreaterThan(0);
    }
  }

  function expectSourceToContainV5PresetArtifact(source: string): void {
    const normalizedSource = normalizeSource(source);

    expect(normalizedSource).toMatch(
      /schema:["']mincho\.defineRulesPreset["']/
    );
    expect(normalizedSource).toContain("version:5");
    expect(normalizedSource).toContain("rootNodeId:");
    expect(normalizedSource).toContain("nodes:[");
  }

  function expectSerializedPresetArtifactsToOmitCx(
    source: string,
    registrySession: DefineRulesRegistrySession
  ): void {
    const normalizedSource = normalizeSource(source);
    const artifactMatches = Array.from(
      normalizedSource.matchAll(/\{schema:["']mincho\.defineRulesPreset["']/g)
    );

    expect(artifactMatches.length).toBeGreaterThanOrEqual(
      registrySession.instances.length
    );
    for (const artifactMatch of artifactMatches) {
      let depth = 0;
      let artifactEndIndex = artifactMatch.index;
      for (
        let index = artifactMatch.index;
        index < normalizedSource.length;
        index += 1
      ) {
        const character = normalizedSource[index];
        if (character === "{") {
          depth += 1;
        }
        if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            artifactEndIndex = index + 1;
            break;
          }
        }
      }
      const artifactSource = normalizedSource.slice(
        artifactMatch.index,
        artifactEndIndex
      );

      expect(artifactSource).toContain("version:5");
      expect(artifactSource).toContain("rootNodeId:");
      expect(artifactSource).toContain("nodes:[");
      expect(artifactSource).not.toContain("registeredSegments:");
      expect(artifactSource).not.toContain("segmentCache:");
      expect(artifactSource).not.toContain("fullResultCache:");
      expect(artifactSource).not.toContain("atomicClassByClassName:");
      expect(artifactSource).not.toContain("cx:");
      expect(artifactSource).not.toContain('"cx":');
      expect(artifactSource).not.toContain("'cx':");
    }
    for (const instance of registrySession.instances) {
      expect(Object.hasOwn(instance.presetArtifact, "cx")).toBe(false);
    }
  }

  function expectSerializedSourcePresetArtifactsToOmitCx(source: string): void {
    const normalizedSource = normalizeSource(source);
    const artifactMatches = Array.from(
      normalizedSource.matchAll(/\{schema:["']mincho\.defineRulesPreset["']/g)
    );

    expect(artifactMatches.length).toBeGreaterThan(0);
    for (const artifactMatch of artifactMatches) {
      let depth = 0;
      let artifactEndIndex = artifactMatch.index;
      for (
        let index = artifactMatch.index;
        index < normalizedSource.length;
        index += 1
      ) {
        const character = normalizedSource[index];
        if (character === "{") {
          depth += 1;
        }
        if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            artifactEndIndex = index + 1;
            break;
          }
        }
      }
      const artifactSource = normalizedSource.slice(
        artifactMatch.index,
        artifactEndIndex
      );

      expect(artifactSource).toContain("version:5");
      expect(artifactSource).toContain("rootNodeId:");
      expect(artifactSource).toContain("nodes:[");
      expect(artifactSource).not.toContain("registeredSegments:");
      expect(artifactSource).not.toContain("segmentCache:");
      expect(artifactSource).not.toContain("fullResultCache:");
      expect(artifactSource).not.toContain("atomicClassByClassName:");
      expect(artifactSource).not.toContain("cx:");
      expect(artifactSource).not.toContain('"cx":');
      expect(artifactSource).not.toContain("'cx':");
    }
  }

  function countV5PresetArtifacts(source: string): number {
    return Array.from(
      normalizeSource(source).matchAll(
        /schema:["']mincho\.defineRulesPreset["']/g
      )
    ).length;
  }

  function getRegistryInstanceClassNames(
    instance: DefineRulesRegistrySession["instances"][number] | undefined
  ): string[] {
    return [
      ...new Set(
        instance?.presetArtifact.nodes.flatMap((node) =>
          node.atoms.map((atom) => atom.className)
        ) ?? []
      )
    ];
  }

  type DefineRulesPresetArtifact =
    DefineRulesRegistrySession["instances"][number]["presetArtifact"];

  interface PresetWriteClassNameFilter {
    property: string;
    media: string | null;
    excludeClassNames?: readonly string[];
  }

  const tabletMedia = "screen and (min-width: 768px)";
  const desktopMedia = "screen and (min-width: 1024px)";

  function getPresetWriteClassNames(
    artifact: DefineRulesPresetArtifact,
    filter: PresetWriteClassNameFilter
  ): string[] {
    const excludedClassNames = new Set(filter.excludeClassNames ?? []);
    const classNames: string[] = [];

    for (const atom of artifact.nodes.flatMap((node) => node.atoms)) {
      if (
        atom.property === filter.property &&
        atom.condition.media === filter.media &&
        atom.condition.selector === "&" &&
        excludedClassNames.has(atom.className) === false
      ) {
        classNames.push(atom.className);
      }
    }

    return [...new Set(classNames)];
  }

  function expectSinglePresetWriteClassName(
    artifact: DefineRulesPresetArtifact,
    filter: PresetWriteClassNameFilter
  ): string {
    const classNames = getPresetWriteClassNames(artifact, filter);
    expect(classNames).toHaveLength(1);
    return classNames[0]!;
  }

  function expectPresetArtifactToContainConditionalWrites(
    artifact: DefineRulesPresetArtifact
  ): void {
    const atoms = artifact.nodes.flatMap((node) => node.atoms);
    expect(atoms.map((atom) => atom.condition)).toEqual(
      expect.arrayContaining([
        {
          layer: null,
          supports: null,
          media: null,
          container: null,
          selector: "&"
        },
        {
          layer: null,
          supports: null,
          media: tabletMedia,
          container: null,
          selector: "&"
        },
        {
          layer: null,
          supports: null,
          media: desktopMedia,
          container: null,
          selector: "&"
        }
      ])
    );
    expect(atoms.map((atom) => atom.property)).toEqual(
      expect.arrayContaining(["color", "fontSize"])
    );
  }

  function createCrossPackageConditionalProviderSource(): string {
    return `
      import { defineRules } from "@mincho-js/css";

      const sharedConditions = {
        mobile: {},
        tablet: "@media screen and (min-width: 768px)",
        desktop: { "@media": "screen and (min-width: 1024px)" }
      } as const;
      Object.setPrototypeOf(sharedConditions.mobile, null);
      Object.setPrototypeOf(sharedConditions.desktop, null);
      const sharedProperties = {
        color: true,
        fontSize: true
      } as const;
      const sharedShortcuts = {
        responsiveText: {
          _tablet: { fontSize: 16 },
          fontSize: { _desktop: 20 }
        }
      } as const;

      const provider = defineRules({
        debugId: "cross-package-provider",
        conditions: sharedConditions,
        properties: sharedProperties,
        shortcuts: sharedShortcuts
      });

      export const providerMobileClass = provider.css({
        _mobile: { color: "navy" }
      });
      export const providerClass = provider.css({
        _tablet: { fontSize: 16 },
        fontSize: { _desktop: 20 }
      });
      export const providerTabletClass = provider.css({
        _tablet: { fontSize: 16 }
      });
      export const providerDesktopClass = provider.css({
        fontSize: { _desktop: 20 }
      });
      export const providerPreset = provider.preset;
    `;
  }

  function createCrossPackageConditionalConsumerSource(
    includeCxMergeExports: boolean
  ): string {
    const cxMergeExports = includeCxMergeExports
      ? `
          export const consumerDesktopOverride = consumer.css({
            fontSize: { _desktop: 24 }
          });
          export const consumerTabletOverride = consumer.css({
            _tablet: { fontSize: 18 }
          });
          export const mergedSameCondition = consumer.cx(
            providerClass,
            consumerDesktopOverride
          );
          export const mergedDifferentCondition = consumer.cx(
            providerDesktopClass,
            consumerTabletOverride
          );
        `
      : "";

    return `
      import {
        providerClass,
        providerDesktopClass,
        providerPreset,
        providerTabletClass
      } from "./provider.css.ts";
      import { defineRules } from "@mincho-js/css";

      const sharedConditions = {
        mobile: {},
        tablet: "@media screen and (min-width: 768px)",
        desktop: { "@media": "screen and (min-width: 1024px)" }
      } as const;
      Object.setPrototypeOf(sharedConditions.mobile, null);
      Object.setPrototypeOf(sharedConditions.desktop, null);
      const sharedProperties = {
        color: true,
        fontSize: true
      } as const;
      const sharedShortcuts = {
        responsiveText: {
          _tablet: { fontSize: 16 },
          fontSize: { _desktop: 20 }
        }
      } as const;

      const consumer = defineRules({
        debugId: "cross-package-consumer",
        presets: providerPreset,
        conditions: sharedConditions,
        properties: sharedProperties,
        shortcuts: sharedShortcuts
      });

      export const consumerClass = consumer.css({
        _tablet: { fontSize: 16 },
        fontSize: { _desktop: 20 }
      });
      ${cxMergeExports}
      export const importedProviderClass = providerClass;
      export const importedProviderTabletClass = providerTabletClass;
      export const importedProviderDesktopClass = providerDesktopClass;
      export const importedProviderPreset = providerPreset;
      export const consumerPreset = consumer.preset;
    `;
  }

  async function createCrossPackageConditionalRegistryFixture(
    label: string,
    includeCxMergeExports: boolean
  ): Promise<{
    consumerPath: string;
    source: string;
    cleanup: () => Promise<void>;
  }> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;
    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `defineRulesPreset-cross-package-${fixtureIndex}-${label}`
    );
    const providerPath = path.join(fixtureRoot, "provider.css.ts");

    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(
      providerPath,
      createCrossPackageConditionalProviderSource(),
      "utf8"
    );

    return {
      consumerPath: path.join(fixtureRoot, "consumer.css.ts"),
      source: createCrossPackageConditionalConsumerSource(
        includeCxMergeExports
      ),
      cleanup: () => fs.rm(fixtureRoot, { recursive: true, force: true })
    };
  }

  function createConcurrentRegistryFixtureSource({
    color,
    label,
    stateKey
  }: {
    color: string;
    label: "fileA" | "fileB";
    stateKey: string;
  }): string {
    return `
      import { defineRules } from "@mincho-js/css";

      const state = (globalThis as any)[${JSON.stringify(stateKey)}];
      state.events.push(${JSON.stringify(`start:${label}`)});
      const owner = defineRules({
        debugId: ${JSON.stringify(label)},
        properties: {
          color: true
        }
      });
      export const className = owner.css({ color: ${JSON.stringify(color)} });
      export const preset = owner.preset;
      state.events.push(${JSON.stringify(`registered:${label}`)});
      state.events.push(${JSON.stringify(`end:${label}`)});
    `;
  }

  function createRepeatedRegistryFixtureSource(
    includeRemovedOwner: boolean
  ): string {
    const removedOwnerSource = includeRemovedOwner
      ? `
          const removedOwner = defineRules({
            debugId: "removed-stale",
            properties: {
              padding: true
            }
          });
          export const removedClass = removedOwner.css({ padding: 12 });
          export const removedPreset = removedOwner.preset;
        `
      : "";

    return `
      import { defineRules } from "@mincho-js/css";

      const currentOwner = defineRules({
        debugId: "current-stale",
        properties: {
          color: true
        }
      });
      ${removedOwnerSource}
      export const currentClass = currentOwner.css({ color: "navy" });
      export const currentPreset = currentOwner.preset;
    `;
  }

  function createRegisteredFailureRegistryFixtureSource(
    stateKey: string
  ): string {
    return `
      import { defineRules } from "@mincho-js/css";

      const owner = defineRules({
        debugId: "registered-failure",
        properties: {
          color: true
        }
      });
      export const failedClassName = owner.css({ color: "crimson" });
      (globalThis as any)[${JSON.stringify(stateKey)}].failedClassName = failedClassName;
      throw new Error("registered cleanup failure");
    `;
  }

  describe("registry fixture matrix", () => {
    it("lists the eval-time registry support contract cases", async () => {
      const registryFixtureCases = await loadRegistryFixtureMatrixCases();

      expect(
        registryFixtureCases.map((fixtureCase) => fixtureCase.caseId)
      ).toEqual(expectedRegistryFixtureCaseIds);
    });

    it("serializes executed registry cases and preserves eval-time boundaries", async () => {
      const registryFixtureCases = await loadRegistryFixtureMatrixCases();

      for (const fixtureCase of registryFixtureCases) {
        const fixtureSource = await readRegistryFixtureSource(
          fixtureCase.fixturePath
        );

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        if (fixtureCase.expectedEvaluation === "not-serialized") {
          const registrySession =
            await evaluateRegistryFixtureBeforeExportSerialization(
              fixtureSource,
              fixtureCase.caseId,
              fixtureCase.fixturePath
            );

          expect(registrySession.instances).toHaveLength(
            fixtureCase.expectedRegistryInstances
          );
          continue;
        }

        const { source, registrySession } = await processRegistryFixture(
          fixtureSource,
          fixtureCase.caseId,
          fixtureCase.fixturePath
        );
        const classNames = collectPresetClassNames(registrySession);

        expect(registrySession.instances).toHaveLength(
          fixtureCase.expectedRegistryInstances
        );

        expectSourceToContainV5PresetArtifact(source);
        expectSerializedPresetArtifactsToOmitCx(source, registrySession);
        expectRegistryInstancesToHavePresetAtoms(registrySession);
        expect(classNames.length).toBeGreaterThan(0);
        for (const className of classNames) {
          expect(source).toContain(className);
        }
      }
    }, 20_000);
  });

  describe("defineRules preset registry wrapper", () => {
    it("registry serializes live V5 preset artifacts from processed css calls", async () => {
      const { source, registrySession, emittedCss } =
        await processRegistryFixture(
          `
          import { defineRules } from "@mincho-js/css";

          const button = defineRules({
            debugId: "button",
            properties: {
              color: true
            }
          });

          export const buttonClass = button.css({ color: "red" });
          export const buttonCss = button.css;
        `,
          "serialization"
        );
      const [registeredInstance] = registrySession.instances;
      const classNames = getRegistryInstanceClassNames(registeredInstance);

      expect(registrySession.instances).toHaveLength(1);
      expect(registeredInstance?.registrationIndex).toBe(0);
      expectSourceToContainV5PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expect(classNames).toHaveLength(1);
      expect(source).toContain(classNames[0]!);
      expect(emittedCss).toMatch(/color:\s*red/);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("registry fixture validates V5 artifact extraction and consumer reuse", async () => {
      const { source, registrySession } = await processRegistryFixture(
        `
          import { defineRules } from "@mincho-js/css";

          const provider = defineRules({
            debugId: "provider",
            properties: {
              color: true,
              display: true
            }
          });
          export const providerClass = provider.css({
            color: "rebeccapurple",
            display: "flex"
          });
          export const providerPreset = provider.preset;

          const consumer = defineRules({
            debugId: "consumer",
            presets: provider.preset,
            properties: {
              color: true,
              display: true,
              padding: true
            }
          });
          export const consumerClass = consumer.css({
            color: "rebeccapurple",
            display: "flex"
          });
          export const consumerPreset = consumer.preset;
        `,
        "consumer-reuse"
      );
      const [providerInstance, consumerInstance] = registrySession.instances;
      const providerClassNames =
        getRegistryInstanceClassNames(providerInstance);
      const consumerClassNames =
        getRegistryInstanceClassNames(consumerInstance);

      expect(registrySession.instances).toHaveLength(2);
      expectSourceToContainV5PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expectRegistryInstancesToHavePresetAtoms(registrySession);
      expect(providerClassNames.length).toBeGreaterThan(0);
      expect(consumerClassNames).toEqual(providerClassNames);
      expectSerializedMarkerClassName(
        source,
        "providerClass",
        providerClassNames.join(" ")
      );
      expectSerializedMarkerClassName(
        source,
        "consumerClass",
        providerClassNames.join(" ")
      );
    });

    it("reuses conditional provider preset metadata across package fixture boundaries", async () => {
      const fixture = await createCrossPackageConditionalRegistryFixture(
        "conditional-reuse",
        false
      );

      try {
        const { source, registrySession, emittedCss } =
          await processRegistryFixture(
            fixture.source,
            "conditional-reuse",
            fixture.consumerPath
          );
        const [providerInstance, consumerInstance] = registrySession.instances;

        expect(registrySession.instances).toHaveLength(2);
        expect(providerInstance?.fileScope.filePath).toContain(
          "provider.css.ts"
        );
        expect(consumerInstance?.fileScope.filePath).toContain(
          "consumer.css.ts"
        );
        expectSourceToContainV5PresetArtifact(source);
        expectSerializedSourcePresetArtifactsToOmitCx(source);
        expectRegistryInstancesToHavePresetAtoms(registrySession);
        for (const instance of registrySession.instances) {
          expect(Object.hasOwn(instance.presetArtifact, "cx")).toBe(false);
        }

        const providerArtifact = providerInstance!.presetArtifact;
        const consumerArtifact = consumerInstance!.presetArtifact;
        expectPresetArtifactToContainConditionalWrites(providerArtifact);
        expectPresetArtifactToContainConditionalWrites(consumerArtifact);

        const providerTabletClass = expectSinglePresetWriteClassName(
          providerArtifact,
          { property: "fontSize", media: tabletMedia }
        );
        const providerDesktopClass = expectSinglePresetWriteClassName(
          providerArtifact,
          { property: "fontSize", media: desktopMedia }
        );
        const consumerTabletClass = expectSinglePresetWriteClassName(
          consumerArtifact,
          { property: "fontSize", media: tabletMedia }
        );
        const consumerDesktopClass = expectSinglePresetWriteClassName(
          consumerArtifact,
          { property: "fontSize", media: desktopMedia }
        );
        expect(consumerTabletClass).toBe(providerTabletClass);
        expect(consumerDesktopClass).toBe(providerDesktopClass);
        expectSerializedMarkerClassName(
          source,
          "consumerClass",
          `${providerTabletClass} ${providerDesktopClass}`
        );
        expectSerializedMarkerClassName(
          source,
          "importedProviderClass",
          `${providerTabletClass} ${providerDesktopClass}`
        );
        expect(countV5PresetArtifacts(source)).toBe(2);
        expect(emittedCss).toMatch(/@media\s+screen and \(min-width: 768px\)/);
        expect(emittedCss).toMatch(/@media\s+screen and \(min-width: 1024px\)/);
        expect(emittedCss).toMatch(/font-size:\s*16(?:px)?/);
        expect(emittedCss).toMatch(/font-size:\s*20(?:px)?/);
      } finally {
        await fixture.cleanup();
      }
    });

    it("merges conditional provider and consumer known classes through scoped cx", async () => {
      const fixture = await createCrossPackageConditionalRegistryFixture(
        "conditional-cx-merge",
        true
      );

      try {
        const { source, registrySession, emittedCss } =
          await processRegistryFixture(
            fixture.source,
            "conditional-cx-merge",
            fixture.consumerPath
          );
        const [providerInstance, consumerInstance] = registrySession.instances;

        expect(registrySession.instances).toHaveLength(2);
        expectSourceToContainV5PresetArtifact(source);
        expectSerializedSourcePresetArtifactsToOmitCx(source);
        expectRegistryInstancesToHavePresetAtoms(registrySession);
        for (const instance of registrySession.instances) {
          expect(Object.hasOwn(instance.presetArtifact, "cx")).toBe(false);
        }

        const providerArtifact = providerInstance!.presetArtifact;
        const consumerArtifact = consumerInstance!.presetArtifact;
        expectPresetArtifactToContainConditionalWrites(providerArtifact);
        expectPresetArtifactToContainConditionalWrites(consumerArtifact);

        const providerTabletClass = expectSinglePresetWriteClassName(
          providerArtifact,
          { property: "fontSize", media: tabletMedia }
        );
        const providerDesktopClass = expectSinglePresetWriteClassName(
          providerArtifact,
          { property: "fontSize", media: desktopMedia }
        );
        const consumerDesktopOverride = expectSinglePresetWriteClassName(
          consumerArtifact,
          {
            property: "fontSize",
            media: desktopMedia,
            excludeClassNames: [providerDesktopClass]
          }
        );
        const consumerTabletOverride = expectSinglePresetWriteClassName(
          consumerArtifact,
          {
            property: "fontSize",
            media: tabletMedia,
            excludeClassNames: [providerTabletClass]
          }
        );

        expectSerializedMarkerClassName(
          source,
          "importedProviderClass",
          `${providerTabletClass} ${providerDesktopClass}`
        );
        expect(countV5PresetArtifacts(source)).toBe(2);
        expectSerializedMarkerClassName(
          source,
          "consumerDesktopOverride",
          consumerDesktopOverride
        );
        expectSerializedMarkerClassName(
          source,
          "consumerTabletOverride",
          consumerTabletOverride
        );
        expectSerializedMarkerClassName(
          source,
          "mergedSameCondition",
          `${providerTabletClass} ${consumerDesktopOverride}`
        );
        expectSerializedMarkerClassName(
          source,
          "mergedDifferentCondition",
          `${providerDesktopClass} ${consumerTabletOverride}`
        );
        expect(emittedCss).toMatch(/font-size:\s*18(?:px)?/);
        expect(emittedCss).toMatch(/font-size:\s*24(?:px)?/);
      } finally {
        await fixture.cleanup();
      }
    });

    describe("V5 package fixture diamond ownership", () => {
      it("keeps tracked package fixture artifacts V5-only", async () => {
        const path = await import("node:path");
        const manifest = await loadDefineRulesPresetSerializationManifest();
        const readmePath =
          await getDefineRulesPresetSerializationFixturePath("README.md");
        const fixtureRoot = path.dirname(readmePath);
        const fixtureFiles = await listFixtureFiles(fixtureRoot);
        const legacyMatches: string[] = [];

        for (const fixtureFile of fixtureFiles) {
          if (/[\\/]diamond-v4[\\/]/.test(fixtureFile)) continue;
          if (!/\.(?:js|mjs|ts|md)$/.test(fixtureFile)) continue;

          const fixtureSource = await readRegistryFixtureSource(fixtureFile);
          if (
            /"version":4|version:4|classNameByCache|V4 shape/.test(
              fixtureSource
            )
          ) {
            legacyMatches.push(path.relative(fixtureRoot, fixtureFile));
          }
        }

        expect(manifest.DEFINE_RULES_PRESET_SERIALIZATION_PATHS).toHaveProperty(
          "packageDiamond"
        );
        expect(legacyMatches).toEqual([]);
      });

      it("derives ancestor style imports while preserving package fixture diamond local ownership", async () => {
        const manifest = await loadDefineRulesPresetSerializationManifest();
        const paths = manifest.DEFINE_RULES_PRESET_SERIALIZATION_PATHS;
        const [aCss, bCss, cCss, dCss, dDistSource] = await Promise.all([
          readDefineRulesPresetSerializationFixture(paths.packageDiamondACss),
          readDefineRulesPresetSerializationFixture(paths.packageDiamondBCss),
          readDefineRulesPresetSerializationFixture(paths.packageDiamondCCss),
          readDefineRulesPresetSerializationFixture(
            paths.packageDiamondDistCss
          ),
          readDefineRulesPresetSerializationFixture(paths.packageDiamondDist)
        ]);
        const dArtifact = extractExportedPresetArtifact(dDistSource);
        expect(
          extractExportedPresetArtifact(
            dDistSource.replace(
              '{"schema":"mincho.defineRulesPreset","version":5,',
              '{"version":5,"schema":"mincho.defineRulesPreset",'
            )
          )
        ).toEqual(dArtifact);
        const rootNode = dArtifact.nodes.find(
          (node) => node.nodeId === dArtifact.rootNodeId
        );
        const bNode = dArtifact.nodes.find((node) =>
          node.origin.includes("/diamond-b:")
        );
        const cNode = dArtifact.nodes.find((node) =>
          node.origin.includes("/diamond-c:")
        );

        if (
          rootNode === undefined ||
          bNode === undefined ||
          cNode === undefined
        ) {
          throw new Error("Diamond fixture artifact is missing expected nodes");
        }

        expect(
          dArtifact.nodes.filter((node) => node.origin.includes("/diamond-a:"))
        ).toHaveLength(1);
        expect(rootNode.parents).toEqual([bNode.nodeId, cNode.nodeId]);
        expect(dDistSource).toContain("selected = 'diamond_c_color'");
        expect(aCss).toContain("display: flex;");
        expect(aCss).not.toContain("color: rebeccapurple;");
        expect(bCss).toContain("color: rebeccapurple;");
        expect(bCss).not.toContain("display: flex;");
        expect(cCss).toContain("color: rebeccapurple;");
        expect(cCss).not.toContain("display: flex;");
        expect(dCss).toContain("padding: 13px;");
        expect(dCss).not.toContain("color: rebeccapurple;");
        expect(dCss).not.toContain("display: flex;");

        const fixturePath = await getDefineRulesPresetSerializationFixturePath(
          paths.packageDiamond
        );
        const { source, registrySession, emittedCss } =
          await processRegistryFixture(
            resolvePackageDiamondFixtureSpecifiers(
              await readRegistryFixtureSource(fixturePath)
            ),
            "package-fixture-diamond",
            fixturePath
          );
        const [instance] = registrySession.instances;

        expect(registrySession.instances).toHaveLength(1);
        expectSourceToContainV5PresetArtifact(source);
        expect(source).toMatch(/selected = '[^']*diamond_c_color'/);
        expect(source).toMatch(/inherited = '[^']*diamond_a_display'/);
        expect(source).toMatch(/acceptsHistoricalB = '[^']*diamond_b_color'/);
        expect(source).toMatch(/acceptsHistoricalC = '[^']*diamond_c_color'/);
        expect(source).toMatch(
          /acceptsBothHistorical = '[^']*diamond_c_color'/
        );
        expect(source).toContain("diamond_b_color");
        expect(source).toContain("diamond_c_color");
        expect(instance?.presetArtifact.nodes).toHaveLength(4);
        expect(
          instance?.presetArtifact.nodes.filter((node) =>
            node.origin.includes("/diamond-a:")
          )
        ).toHaveLength(1);
        expect(emittedCss).toContain("padding: 13px");
        expect(emittedCss).not.toContain("color: rebeccapurple");
        expect(emittedCss).not.toContain("display: flex");
        expect(getDefineRulesAncestorStyleSpecifiers(registrySession)).toEqual([
          "@mincho-js-proof/diamond-a/style.css",
          "@mincho-js-proof/diamond-b/style.css",
          "@mincho-js-proof/diamond-c/style.css"
        ]);
      });

      it("preserves package fixture diamond reversed order and exact duplicate nodes", async () => {
        const manifest = await loadDefineRulesPresetSerializationManifest();
        const paths = manifest.DEFINE_RULES_PRESET_SERIALIZATION_PATHS;
        const reversedPath = await getDefineRulesPresetSerializationFixturePath(
          paths.packageDiamondReversed
        );
        const duplicatePath =
          await getDefineRulesPresetSerializationFixturePath(
            paths.packageDiamondDuplicate
          );
        const reversedResult = await processRegistryFixture(
          resolvePackageDiamondFixtureSpecifiers(
            await readRegistryFixtureSource(reversedPath)
          ),
          "package-fixture-diamond-reversed",
          reversedPath
        );
        const duplicateResult = await processRegistryFixture(
          resolvePackageDiamondFixtureSpecifiers(
            await readRegistryFixtureSource(duplicatePath)
          ),
          "package-fixture-diamond-duplicate",
          duplicatePath
        );

        expect(reversedResult.source).toMatch(
          /selected = '[^']*diamond_b_color'/
        );
        expect(reversedResult.source).toMatch(
          /acceptsBothHistorical = '[^']*diamond_b_color'/
        );
        expect(reversedResult.source).toContain("diamond_b_color");
        expect(reversedResult.source).toContain("diamond_c_color");
        expectSourceToContainV5PresetArtifact(duplicateResult.source);
        expect(
          duplicateResult.registrySession.instances[0]?.presetArtifact.nodes.filter(
            (node) => node.origin.includes("/diamond-a:")
          )
        ).toHaveLength(1);
      });

      it("rejects package fixture diamond revision class cycle malformed and V4 contracts", async () => {
        const manifest = await loadDefineRulesPresetSerializationManifest();

        for (const fixtureCase of manifest.DEFINE_RULES_PRESET_SERIALIZATION_PACKAGE_DIAMOND_FAILURE_CASES) {
          const fixturePath =
            await getDefineRulesPresetSerializationFixturePath(
              fixtureCase.relativePath
            );
          let thrownError: unknown;

          try {
            await processRegistryFixture(
              resolvePackageDiamondFixtureSpecifiers(
                await readRegistryFixtureSource(fixturePath)
              ),
              `package-fixture-diamond-${fixtureCase.caseId}`,
              fixturePath
            );
          } catch (error) {
            thrownError = error;
          }

          if (!(thrownError instanceof Error)) {
            throw new Error(`${fixtureCase.caseId} did not reject`);
          }

          expect(thrownError.message).toContain(fixtureCase.expectedDiagnostic);
          if (fixtureCase.caseId === "cycle") {
            expect(thrownError.message).toContain("parents[0]");
            expect(thrownError.message).toContain("diamond-cycle");
          }
          if (fixtureCase.caseId === "same-origin-different-revision") {
            expect(thrownError.message).toContain("diamond-revision");
          }
        }
      });
    });

    it("cleanup ends sessions after success, evaluation errors, and skipped registration", async () => {
      await processRegistryFixture(
        `
          import { defineRules } from "@mincho-js/css";

          const rules = defineRules({ properties: { color: true } });
          export const className = rules.css({ color: "green" });
        `,
        "cleanup-success"
      );

      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);

      await expect(
        processDefineRulesPresetRegistryFile({
          source: 'throw new Error("evaluation failed");',
          filePath: createRegistryFixturePath("cleanup-evaluation-error"),
          identOption: "debug"
        })
      ).rejects.toThrow("evaluation failed");

      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);

      const functionConfigResult = await processRegistryFixture(
        `
            import { defineRules } from "@mincho-js/css";

            const functionConfig = defineRules({
              properties: {
                color(value: string) {
                  return value;
                }
              }
            });

            export const raw = functionConfig.css.raw({ color: "red" });
          `,
        "cleanup-skipped-registration"
      );

      expect(functionConfigResult.registrySession.instances).toHaveLength(0);

      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("serializes owner-object defineRules css calls composed with returned cx", async () => {
      const { source, registrySession, emittedCss } =
        await processRegistryFixture(
          `
          import { defineRules } from "@mincho-js/css";

          const owner = defineRules({
            debugId: "owner-returned-cx",
            properties: {
              color: true
            }
          });
          export const ownerClassName = owner.cx(owner.css({ color: "hotpink" }), "owner-external");
          export const ownerPreset = owner.preset;
        `,
          "owner-returned-cx"
        );
      const [ownerInstance] = registrySession.instances;
      const ownerClassNames = getRegistryInstanceClassNames(ownerInstance);

      expect(registrySession.instances).toHaveLength(1);
      expectSourceToContainV5PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expectRegistryInstancesToHavePresetAtoms(registrySession);
      expect(ownerClassNames).toHaveLength(1);
      expect(source).toContain(
        `ownerClassName = '${ownerClassNames[0]} owner-external'`
      );
      expect(source).toContain("owner-external");
      expect(source).toContain(ownerClassNames[0]!);
      expect(emittedCss).toMatch(/color:\s*hotpink/);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("serializes destructured defineRules css calls composed with returned cx", async () => {
      const { source, registrySession, emittedCss } =
        await processRegistryFixture(
          `
          import { defineRules } from "@mincho-js/css";

          const { css, cx, preset } = defineRules({
            debugId: "destructured-returned-cx",
            properties: {
              display: true
            }
          });
          export const destructuredClassName = cx(css({ display: "flex" }), "destructured-external");
          export const destructuredPreset = preset;
        `,
          "destructured-returned-cx"
        );
      const [destructuredInstance] = registrySession.instances;
      const destructuredClassNames =
        getRegistryInstanceClassNames(destructuredInstance);

      expect(registrySession.instances).toHaveLength(1);
      expectSourceToContainV5PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expectRegistryInstancesToHavePresetAtoms(registrySession);
      expect(destructuredClassNames).toHaveLength(1);
      expect(source).toContain(
        `destructuredClassName = '${destructuredClassNames[0]} destructured-external'`
      );
      expect(source).toContain("destructured-external");
      expect(source).toContain(destructuredClassNames[0]!);
      expect(emittedCss).toMatch(/display:\s*flex/);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("concurrent registry wrapper evaluations are queued and isolated", async () => {
      const registryGlobals = globalThis as Record<string, unknown>;
      const stateKey = `__minchoDefineRulesRegistryConcurrent${fixtureIndex}`;
      const concurrentState = {
        events: [] as string[],
        gates: {
          fileA: createDeferred<void>()
        },
        processed: {
          fileA: createDeferred<void>(),
          fileB: createDeferred<void>()
        }
      };
      const fileAPath = createRegistryFixturePath("concurrent-file-a");
      const fileBPath = createRegistryFixturePath("concurrent-file-b");
      registryGlobals[stateKey] = concurrentState;

      const firstEvaluation = runDefineRulesPresetRegistryStep(async () => {
        const result = await processRegistryFixture(
          createConcurrentRegistryFixtureSource({
            color: "crimson",
            label: "fileA",
            stateKey
          }),
          "concurrent-file-a",
          fileAPath
        );
        concurrentState.events.push("queued:fileA");
        concurrentState.processed.fileA.resolve();
        await concurrentState.gates.fileA.promise;
        return result;
      });
      const secondEvaluation = runDefineRulesPresetRegistryStep(async () => {
        const result = await processRegistryFixture(
          createConcurrentRegistryFixtureSource({
            color: "teal",
            label: "fileB",
            stateKey
          }),
          "concurrent-file-b",
          fileBPath
        );
        concurrentState.events.push("queued:fileB");
        concurrentState.processed.fileB.resolve();
        return result;
      });

      try {
        await concurrentState.processed.fileA.promise;
        expect(concurrentState.events).toEqual([
          "start:fileA",
          "registered:fileA",
          "end:fileA",
          "queued:fileA"
        ]);
        expect(concurrentState.events).not.toContain("start:fileB");

        concurrentState.gates.fileA.resolve();
        await concurrentState.processed.fileB.promise;
        expect(concurrentState.events).toEqual([
          "start:fileA",
          "registered:fileA",
          "end:fileA",
          "queued:fileA",
          "start:fileB",
          "registered:fileB",
          "end:fileB",
          "queued:fileB"
        ]);

        const [firstResult, secondResult] = await Promise.all([
          firstEvaluation,
          secondEvaluation
        ]);
        const firstClassNames = collectPresetClassNames(
          firstResult.registrySession
        );
        const secondClassNames = collectPresetClassNames(
          secondResult.registrySession
        );

        expect(concurrentState.events).toEqual([
          "start:fileA",
          "registered:fileA",
          "end:fileA",
          "queued:fileA",
          "start:fileB",
          "registered:fileB",
          "end:fileB",
          "queued:fileB"
        ]);
        expect(
          firstResult.registrySession.instances.map(
            (instance) => instance.registrationIndex
          )
        ).toEqual([0]);
        expect(
          secondResult.registrySession.instances.map(
            (instance) => instance.registrationIndex
          )
        ).toEqual([0]);
        expect(
          fileAPath.endsWith(
            firstResult.registrySession.instances[0]?.fileScope.filePath ?? ""
          )
        ).toBe(true);
        expect(
          fileBPath.endsWith(
            secondResult.registrySession.instances[0]?.fileScope.filePath ?? ""
          )
        ).toBe(true);
        expect(countV5PresetArtifacts(firstResult.source)).toBe(1);
        expect(countV5PresetArtifacts(secondResult.source)).toBe(1);
        expectSourceToContainV5PresetArtifact(firstResult.source);
        expectSourceToContainV5PresetArtifact(secondResult.source);
        expectRegistryInstancesToHavePresetAtoms(firstResult.registrySession);
        expectRegistryInstancesToHavePresetAtoms(secondResult.registrySession);
        expect(firstClassNames).toHaveLength(1);
        expect(secondClassNames).toHaveLength(1);

        for (const firstClassName of firstClassNames) {
          expect(firstResult.source).toContain(firstClassName);
          expect(secondResult.source).not.toContain(firstClassName);
        }
        for (const secondClassName of secondClassNames) {
          expect(secondResult.source).toContain(secondClassName);
          expect(firstResult.source).not.toContain(secondClassName);
        }
        expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
      } finally {
        concurrentState.gates.fileA.resolve();
        await Promise.allSettled([firstEvaluation, secondEvaluation]);
        delete registryGlobals[stateKey];
      }
    });

    it("cleanup removes a failed registered session before the next evaluation", async () => {
      const registryGlobals = globalThis as Record<string, unknown>;
      const stateKey = `__minchoDefineRulesRegistryCleanup${fixtureIndex}`;
      const cleanupState: { failedClassName?: string } = {};
      registryGlobals[stateKey] = cleanupState;

      try {
        await expect(
          runDefineRulesPresetRegistryStep(() =>
            processRegistryFixture(
              createRegisteredFailureRegistryFixtureSource(stateKey),
              "cleanup-registered-failure"
            )
          )
        ).rejects.toThrow("registered cleanup failure");

        expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
        if (typeof cleanupState.failedClassName !== "string") {
          throw new Error("Expected failure fixture to record a class name");
        }

        const successfulResult = await runDefineRulesPresetRegistryStep(() =>
          processRegistryFixture(
            `
              import { defineRules } from "@mincho-js/css";

              const owner = defineRules({
                debugId: "cleanup-success-after-failure",
                properties: {
                  color: true
                }
              });
              export const className = owner.css({ color: "seagreen" });
              export const preset = owner.preset;
            `,
            "cleanup-success-after-registered-failure"
          )
        );

        expect(successfulResult.registrySession.instances).toHaveLength(1);
        expect(
          successfulResult.registrySession.instances[0]?.registrationIndex
        ).toBe(0);
        expectRegistryInstancesToHavePresetAtoms(
          successfulResult.registrySession
        );
        expectSourceToContainV5PresetArtifact(successfulResult.source);
        expect(successfulResult.source).not.toContain(
          cleanupState.failedClassName
        );
        expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
      } finally {
        delete registryGlobals[stateKey];
      }
    });

    it("repeated transforms for the same file path drop stale registry instances", async () => {
      const filePath = createRegistryFixturePath("repeated-stale");
      const firstResult = await processRegistryFixture(
        createRepeatedRegistryFixtureSource(true),
        "repeated-stale-first",
        filePath
      );
      const [firstCurrentInstance, firstRemovedInstance] =
        firstResult.registrySession.instances;
      const firstCurrentClassNames =
        getRegistryInstanceClassNames(firstCurrentInstance);
      const firstRemovedClassNames =
        getRegistryInstanceClassNames(firstRemovedInstance);

      expect(
        firstResult.registrySession.instances.map(
          (instance) => instance.registrationIndex
        )
      ).toEqual([0, 1]);
      expect(countV5PresetArtifacts(firstResult.source)).toBe(2);
      expectSourceToContainV5PresetArtifact(firstResult.source);
      expectRegistryInstancesToHavePresetAtoms(firstResult.registrySession);
      expect(firstCurrentClassNames).toHaveLength(1);
      expect(firstRemovedClassNames).toHaveLength(1);

      const secondResult = await processRegistryFixture(
        createRepeatedRegistryFixtureSource(false),
        "repeated-stale-second",
        filePath
      );
      const [secondCurrentInstance] = secondResult.registrySession.instances;
      const secondCurrentClassNames = getRegistryInstanceClassNames(
        secondCurrentInstance
      );

      expect(secondResult.registrySession.instances).toHaveLength(1);
      expect(secondCurrentInstance?.registrationIndex).toBe(0);
      expect(countV5PresetArtifacts(secondResult.source)).toBe(1);
      expectSourceToContainV5PresetArtifact(secondResult.source);
      expectRegistryInstancesToHavePresetAtoms(secondResult.registrySession);
      expect(secondCurrentClassNames).toHaveLength(1);
      for (const secondCurrentClassName of secondCurrentClassNames) {
        expect(secondResult.source).toContain(secondCurrentClassName);
      }
      for (const firstRemovedClassName of firstRemovedClassNames) {
        expect(firstResult.source).toContain(firstRemovedClassName);
        expect(secondResult.source).not.toContain(firstRemovedClassName);
      }
      expect(secondResult.source).not.toContain("removedClass");
      expect(secondResult.source).not.toContain("removedPreset");
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("valid config validation accepts serializable condition data", () => {
      expect(() =>
        validateDefineRulesRegistrySession(
          createRegistrySession({
            conditions: {
              mobile: {},
              tablet: "screen and (min-width: 768px)",
              desktop: {
                "@media": "screen and (min-width: 1024px)",
                selector: "&[data-desktop]"
              }
            },
            properties: {
              color: true
            },
            shortcuts: {
              layout: ["color"]
            }
          })
        )
      ).not.toThrow();
    });

    it("rejects origins without a package separator", () => {
      expect(() => getOriginPackage("missing-separator")).toThrow(
        "defineRules preset origin is missing a package separator: missing-separator"
      );
      expect(
        getOriginPackage("@scope/package:src/rules.ts#defineRules:0")
      ).toBe("@scope/package");
    });

    it("reuses each preset snapshot after registry validation", () => {
      const registrySession = createRegistrySession({});
      const [instance] = registrySession.instances;
      if (instance === undefined) throw new Error("Expected registry instance");
      const getPresetSnapshot = instance.getPresetSnapshot;
      let snapshotReadCount = 0;
      instance.getPresetSnapshot = () => {
        snapshotReadCount += 1;
        return getPresetSnapshot();
      };
      const presetArtifacts =
        validateDefineRulesRegistrySessionArtifacts(registrySession);

      expect(
        getDefineRulesAncestorStyleSpecifiersFromArtifacts(presetArtifacts)
      ).toEqual([]);
      expect(snapshotReadCount).toBe(1);
    });

    it("rejects version 4 preset snapshots with the V5 diagnostic", () => {
      expect(() =>
        parseDefineRulesPresetArtifactV5({
          schema: "mincho.defineRulesPreset",
          version: 4,
          classNameByCache: {}
        })
      ).toThrow("expected defineRules preset version 5");
    });

    it("valid config validation accepts serializable context data", () => {
      const nullPrototypePalette = Object.assign(
        Object.create(null) as { brand: string; accent: null },
        {
          brand: "rebeccapurple",
          accent: null
        }
      );
      const context = {
        palette: nullPrototypePalette,
        spacing: [0, 4, undefined],
        enabled: true
      };
      Object.defineProperty(context.palette, "resolve", {
        enumerable: false,
        value() {
          return context.palette.brand;
        }
      });

      expect(() =>
        validateDefineRulesRegistrySession(
          createRegistrySession({
            context,
            properties: {
              color: true
            }
          })
        )
      ).not.toThrow();
    });

    it("invalid config validation rejects non-serializable context with paths and registry metadata", () => {
      class PaletteClass {
        brand = "red";
      }
      const customPrototype = Object.create(null) as { kind?: string };
      customPrototype.kind = "palette";
      const customPrototypeContext = Object.create(customPrototype) as {
        brand?: string;
      };
      customPrototypeContext.brand = "red";
      const cyclicContext: { self?: unknown } = {};
      cyclicContext.self = cyclicContext;
      const cases = [
        {
          context: {
            palette: {
              resolve() {
                return "red";
              }
            }
          },
          path: "config.context.palette.resolve"
        },
        {
          context: { createdAt: new Date(0) },
          path: "config.context.createdAt"
        },
        {
          context: { palette: new Map([["brand", "red"]]) },
          path: "config.context.palette"
        },
        {
          context: { palette: new Set(["red"]) },
          path: "config.context.palette"
        },
        {
          context: { count: BigInt(1) },
          path: "config.context.count"
        },
        {
          context: { token: Symbol("token") },
          path: "config.context.token"
        },
        {
          context: cyclicContext,
          path: "config.context.self"
        },
        {
          context: { palette: new PaletteClass() },
          path: "config.context.palette"
        },
        {
          context: { palette: customPrototypeContext },
          path: "config.context.palette"
        }
      ];

      for (const { context, path } of cases) {
        expect(() =>
          validateDefineRulesRegistrySession(
            createRegistrySession({
              context,
              properties: {
                color: true
              }
            })
          )
        ).toThrow(
          `defineRules registry serialization does not support non-serializable context at ${path} (fileScope: test:registry.css.ts, registrationIndex: 0)`
        );
      }
    });

    it("registry fixture processing rejects non-serializable context with registry metadata", async () => {
      await expectRegistryFixtureToRejectWithDiagnostic({
        caseId: "registry-context-function-invalid",
        expectedPath: "config.context.palette.resolve",
        relativePath: "registry-context-function-invalid/src/index.css.ts"
      });
      await expectRegistryFixtureToRejectWithDiagnostic({
        caseId: "registry-context-date-invalid",
        expectedPath: "config.context.createdAt",
        relativePath: "registry-context-date-invalid/src/index.css.ts"
      });
    });

    it("registry fixture processing rejects custom-prototype context with registry metadata", async () => {
      let thrownError: unknown;

      try {
        await processRegistryFixture(
          `
            import { defineRules } from "@mincho-js/css";

            const customPrototype = Object.create(null);
            customPrototype.kind = "palette";
            const palette = Object.create(customPrototype);
            palette.brand = "red";

            const owner = defineRules({
              context: { palette },
              properties: {
                color: true
              }
            });

            export const className = owner.css({ color: "red" });
            export const preset = owner.preset;
          `,
          "registry-context-custom-prototype-invalid"
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      const message = (thrownError as Error).message;
      expect(message).toContain(
        "defineRules registry serialization does not support non-serializable context at config.context.palette"
      );
      expect(message).toContain("fileScope:");
      expect(message).toContain("registrationIndex: 0");
    });

    it("invalid config validation rejects function-valued conditions, properties, and shortcuts with paths and registry metadata", () => {
      expect(() =>
        validateDefineRulesRegistrySession(
          createRegistrySession({
            conditions: {
              dynamic: {
                selector(value: string) {
                  return value;
                }
              }
            }
          })
        )
      ).toThrow(
        "defineRules registry serialization does not support function-valued conditions, properties, or shortcuts at config.conditions.dynamic.selector (fileScope: test:registry.css.ts, registrationIndex: 0)"
      );

      expect(() =>
        validateDefineRulesRegistrySession(
          createRegistrySession({
            properties: {
              color(value: string) {
                return value;
              }
            }
          })
        )
      ).toThrow(
        "defineRules registry serialization does not support function-valued conditions, properties, or shortcuts at config.properties.color (fileScope: test:registry.css.ts, registrationIndex: 0)"
      );

      expect(() =>
        validateDefineRulesRegistrySession(
          createRegistrySession({
            properties: {
              color: true
            },
            shortcuts: {
              layout: [
                "color",
                {
                  tone(value: string) {
                    return {
                      color: value
                    };
                  }
                }
              ]
            }
          })
        )
      ).toThrow(
        "defineRules registry serialization does not support function-valued conditions, properties, or shortcuts at config.shortcuts.layout[1].tone (fileScope: test:registry.css.ts, registrationIndex: 0)"
      );
    });

    it("registry queue serializes steps and recovers after rejection", async () => {
      const firstGate = createDeferred<void>();
      const processOrder: string[] = [];

      const firstStep = runDefineRulesPresetRegistryStep(async () => {
        processOrder.push("start:first");
        await firstGate.promise;
        processOrder.push("end:first");
        return "first";
      });
      const secondStep = runDefineRulesPresetRegistryStep(() => {
        processOrder.push("start:second");
        processOrder.push("end:second");
        return "second";
      });

      await vi.waitFor(() => {
        expect(processOrder).toEqual(["start:first"]);
      });

      firstGate.resolve();
      await expect(Promise.all([firstStep, secondStep])).resolves.toEqual([
        "first",
        "second"
      ]);

      expect(processOrder).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second"
      ]);

      await expect(
        runDefineRulesPresetRegistryStep(() => {
          throw new Error("queued failure");
        })
      ).rejects.toThrow("queued failure");
      await expect(
        runDefineRulesPresetRegistryStep(() => "recovered")
      ).resolves.toBe("recovered");
    });
  });
}
