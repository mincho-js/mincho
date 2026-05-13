import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession,
  getActiveDefineRulesRegistrySession,
  type DefineRulesRegistrySession
} from "@mincho-js/css/defineRules/registry";
import { processVanillaFile } from "@vanilla-extract/integration";

const DEFINE_RULES_REGISTRY_SERIALIZABLE_CONFIG_DIAGNOSTIC =
  "defineRules registry serialization does not support function-valued properties or shortcuts";

type Awaitable<Value> = Value | PromiseLike<Value>;

let defineRulesPresetRegistryQueue: Promise<void> = Promise.resolve();

export type DefineRulesPresetRegistryFileOptions = Parameters<
  typeof processVanillaFile
>[0];

export interface DefineRulesPresetRegistryResult {
  source: string;
  registrySession: DefineRulesRegistrySession;
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
    validateDefineRulesRegistrySession(registrySession);

    return {
      source,
      registrySession
    };
  } finally {
    endDefineRulesRegistrySession();
  }
}

export function validateDefineRulesRegistrySession(
  registrySession: DefineRulesRegistrySession
): void {
  for (const instance of registrySession.instances) {
    const diagnosticContext = {
      fileScope: instance.fileScope,
      registrationIndex: instance.registrationIndex
    };

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
  }
}

interface DefineRulesRegistryDiagnosticContext {
  fileScope: DefineRulesRegistrySession["instances"][number]["fileScope"];
  registrationIndex: number;
}

function formatDefineRulesRegistryDiagnosticContext(
  diagnosticContext: DefineRulesRegistryDiagnosticContext
): string {
  const packageName = diagnosticContext.fileScope.packageName ?? "<root>";

  return `fileScope: ${packageName}:${diagnosticContext.fileScope.filePath}, registrationIndex: ${diagnosticContext.registrationIndex}`;
}

function getConfigEntry(
  config: unknown,
  key: "properties" | "shortcuts"
): unknown {
  if (config == null || typeof config !== "object") {
    return undefined;
  }

  return (config as Record<string, unknown>)[key];
}

function validateSerializableConfigEntry(
  entry: unknown,
  path: string,
  diagnosticContext: DefineRulesRegistryDiagnosticContext,
  seenEntries: WeakSet<object> = new WeakSet()
): void {
  if (typeof entry === "function") {
    throw new Error(
      `${DEFINE_RULES_REGISTRY_SERIALIZABLE_CONFIG_DIAGNOSTIC} at ${path} (${formatDefineRulesRegistryDiagnosticContext(diagnosticContext)})`
    );
  }

  if (entry == null || typeof entry !== "object") {
    return;
  }

  if (seenEntries.has(entry)) {
    return;
  }
  seenEntries.add(entry);

  if (Array.isArray(entry)) {
    entry.forEach((item, index) => {
      validateSerializableConfigEntry(
        item,
        `${path}[${index}]`,
        diagnosticContext,
        seenEntries
      );
    });
    return;
  }

  for (const [key, value] of Object.entries(entry)) {
    validateSerializableConfigEntry(
      value,
      `${path}${formatConfigPathSegment(key)}`,
      diagnosticContext,
      seenEntries
    );
  }
}

function formatConfigPathSegment(key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `.${key}`;
  }

  return `[${JSON.stringify(key)}]`;
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
          presetArtifact: {
            schema: "mincho.defineRulesPreset",
            version: 4,
            classNameByCache: {},
            writeKeyByCacheKey: {},
            conditionById: {},
            propertyById: {},
            writeKeyById: {}
          },
          getPresetSnapshot: () => ({
            schema: "mincho.defineRulesPreset",
            version: 4,
            classNameByCache: {},
            writeKeyByCacheKey: {},
            conditionById: {},
            propertyById: {},
            writeKeyById: {}
          })
        }
      ],
      nextRegistrationIndex: 1,
      nextRegistrationIndexByFileScope: {
        "test:registry.css.ts": 1
      }
    };
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

  async function loadRegistryFixtureMatrixCases(): Promise<
    RegistryFixtureCase[]
  > {
    const manifest = (await import(
      getDefineRulesPresetSerializationManifestUrl()
    )) as DefineRulesPresetSerializationManifest;

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

  function normalizeRegistryFixtureSource(source: string): string {
    return source.replace(/\s+/g, " ").trim();
  }

  function expectSourceToContainSnippet(source: string, snippet: string): void {
    expect(normalizeRegistryFixtureSource(source)).toContain(
      normalizeRegistryFixtureSource(snippet)
    );
  }

  function collectClassNameByCacheValues(
    registrySession: DefineRulesRegistrySession
  ): string[] {
    return registrySession.instances.flatMap((instance) =>
      Object.values(instance.presetArtifact.classNameByCache)
    );
  }

  function expectRegistryInstancesToHaveClassNameByCache(
    registrySession: DefineRulesRegistrySession
  ): void {
    for (const instance of registrySession.instances) {
      expect(
        Object.keys(instance.presetArtifact.classNameByCache).length
      ).toBeGreaterThan(0);
    }
  }

  function expectSourceToContainV4PresetArtifact(source: string): void {
    const normalizedSource = normalizeSource(source);

    expect(normalizedSource).toMatch(
      /schema:["']mincho\.defineRulesPreset["']/
    );
    expect(normalizedSource).toContain("version:4");
    expect(normalizedSource).toContain("classNameByCache:{");
    expect(normalizedSource).toContain("writeKeyByCacheKey:{");
    expect(normalizedSource).toContain("conditionById:{");
    expect(normalizedSource).toContain("propertyById:{");
    expect(normalizedSource).toContain("writeKeyById:{");
  }

  function expectSerializedPresetArtifactsToOmitCx(
    source: string,
    registrySession: DefineRulesRegistrySession
  ): void {
    const normalizedSource = normalizeSource(source);
    const artifactMatches = Array.from(
      normalizedSource.matchAll(/\{schema:["']mincho\.defineRulesPreset["']/g)
    );

    expect(artifactMatches).toHaveLength(registrySession.instances.length);
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

      expect(artifactSource).toContain("version:4");
      expect(artifactSource).toContain("classNameByCache:{");
      expect(artifactSource).toContain("writeKeyByCacheKey:{");
      expect(artifactSource).toContain("conditionById:{");
      expect(artifactSource).toContain("propertyById:{");
      expect(artifactSource).toContain("writeKeyById:{");
      expect(artifactSource).not.toContain("cx:");
      expect(artifactSource).not.toContain('"cx":');
      expect(artifactSource).not.toContain("'cx':");
    }
    for (const instance of registrySession.instances) {
      expect(Object.hasOwn(instance.presetArtifact, "cx")).toBe(false);
    }
  }

  function countV4PresetArtifacts(source: string): number {
    return Array.from(
      normalizeSource(source).matchAll(
        /schema:["']mincho\.defineRulesPreset["']/g
      )
    ).length;
  }

  function getRegistryInstanceClassNames(
    instance: DefineRulesRegistrySession["instances"][number] | undefined
  ): string[] {
    return Object.values(instance?.presetArtifact.classNameByCache ?? {});
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
        const normalizedSource = normalizeSource(source);
        const classNames = collectClassNameByCacheValues(registrySession);

        expect(registrySession.instances).toHaveLength(
          fixtureCase.expectedRegistryInstances
        );

        expect(normalizedSource).toMatch(
          /schema:["']mincho\.defineRulesPreset["']/
        );
        expect(normalizedSource).toContain("version:4");
        expect(normalizedSource).toContain("classNameByCache:{");
        expect(normalizedSource).toContain("writeKeyByCacheKey:{");
        expect(normalizedSource).toContain("conditionById:{");
        expect(normalizedSource).toContain("propertyById:{");
        expect(normalizedSource).toContain("writeKeyById:{");
        expectRegistryInstancesToHaveClassNameByCache(registrySession);
        expect(classNames.length).toBeGreaterThan(0);
        for (const className of classNames) {
          expect(source).toContain(className);
        }
      }
    }, 10_000);
  });

  describe("defineRules preset registry wrapper", () => {
    it("registry serializes live v4 preset artifacts from processed css calls", async () => {
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
      const classNames = Object.values(
        registeredInstance?.presetArtifact.classNameByCache ?? {}
      );
      const normalizedSource = normalizeSource(source);

      expect(registrySession.instances).toHaveLength(1);
      expect(registeredInstance?.registrationIndex).toBe(0);
      expect(normalizedSource).toMatch(
        /schema:["']mincho\.defineRulesPreset["']/
      );
      expect(normalizedSource).toContain("version:4");
      expect(normalizedSource).toContain("classNameByCache:{");
      expect(normalizedSource).toContain("writeKeyByCacheKey:{");
      expect(normalizedSource).toContain("conditionById:{");
      expect(normalizedSource).toContain("propertyById:{");
      expect(normalizedSource).toContain("writeKeyById:{");
      expect(classNames).toHaveLength(1);
      expect(source).toContain(classNames[0]!);
      expect(emittedCss).toMatch(/color:\s*red/);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("registry fixture validates v4 artifact extraction and consumer reuse", async () => {
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
      const providerClassNames = Object.values(
        providerInstance?.presetArtifact.classNameByCache ?? {}
      );
      const consumerClassNames = Object.values(
        consumerInstance?.presetArtifact.classNameByCache ?? {}
      );

      expect(registrySession.instances).toHaveLength(2);
      expectSourceToContainV4PresetArtifact(source);
      expectRegistryInstancesToHaveClassNameByCache(registrySession);
      const reusedClassName = providerClassNames.join(" ");

      expect(providerClassNames.length).toBeGreaterThan(0);
      expect(consumerClassNames).toEqual(providerClassNames);
      expect(source).toContain(`providerClass = '${reusedClassName}'`);
      expect(source).toContain(`consumerClass = '${reusedClassName}'`);
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
      expectSourceToContainV4PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expectRegistryInstancesToHaveClassNameByCache(registrySession);
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
      expectSourceToContainV4PresetArtifact(source);
      expectSerializedPresetArtifactsToOmitCx(source, registrySession);
      expectRegistryInstancesToHaveClassNameByCache(registrySession);
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
        const firstClassNames = collectClassNameByCacheValues(
          firstResult.registrySession
        );
        const secondClassNames = collectClassNameByCacheValues(
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
        expect(countV4PresetArtifacts(firstResult.source)).toBe(1);
        expect(countV4PresetArtifacts(secondResult.source)).toBe(1);
        expectSourceToContainV4PresetArtifact(firstResult.source);
        expectSourceToContainV4PresetArtifact(secondResult.source);
        expectRegistryInstancesToHaveClassNameByCache(
          firstResult.registrySession
        );
        expectRegistryInstancesToHaveClassNameByCache(
          secondResult.registrySession
        );
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
        expectRegistryInstancesToHaveClassNameByCache(
          successfulResult.registrySession
        );
        expectSourceToContainV4PresetArtifact(successfulResult.source);
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
      expect(countV4PresetArtifacts(firstResult.source)).toBe(2);
      expectSourceToContainV4PresetArtifact(firstResult.source);
      expectRegistryInstancesToHaveClassNameByCache(
        firstResult.registrySession
      );
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
      expect(countV4PresetArtifacts(secondResult.source)).toBe(1);
      expectSourceToContainV4PresetArtifact(secondResult.source);
      expectRegistryInstancesToHaveClassNameByCache(
        secondResult.registrySession
      );
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

    it("invalid config validation rejects function-valued properties and shortcuts with paths and registry metadata", () => {
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
        "defineRules registry serialization does not support function-valued properties or shortcuts at config.properties.color (fileScope: test:registry.css.ts, registrationIndex: 0)"
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
        "defineRules registry serialization does not support function-valued properties or shortcuts at config.shortcuts.layout[1].tone (fileScope: test:registry.css.ts, registrationIndex: 0)"
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
