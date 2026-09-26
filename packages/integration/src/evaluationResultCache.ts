import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";
import type { processVanillaFile } from "@vanilla-extract/integration";
import { currentCompilationExecution } from "./compilationExecution.js";
import { cacheDigest } from "./compilationInputs.js";
import { getCompilerIdentity } from "./diskCache.js";
import { proveReusableEvaluation } from "./evaluationProof.js";
import {
  recordCompilationDiagnostic,
  measureCompilationPhase
} from "./diagnostics.js";
import {
  evaluationEnvironment,
  processVanillaWithExecution,
  replayVanillaEvaluation,
  type SerializedVanillaEvaluation
} from "./vanillaEvaluation.js";

type Options = Parameters<typeof processVanillaFile>[0];

function snapshotRegistry(session: DefineRulesRegistrySession) {
  return structuredClone({
    nextRegistrationIndex: session.nextRegistrationIndex,
    nextRegistrationIndexByFileScope: session.nextRegistrationIndexByFileScope,
    instances: session.instances.map((instance) => ({
      registrationId: instance.registrationId,
      fileScope: instance.fileScope,
      registrationIndex: instance.registrationIndex,
      config: instance.config,
      presetArtifact: instance.getPresetSnapshot()
    }))
  });
}

type RegistrySnapshot = ReturnType<typeof snapshotRegistry>;

interface EvaluationResult {
  vanilla: SerializedVanillaEvaluation;
  registry: RegistrySnapshot;
}

/** Result replay requires closed inputs, compatible serialization and snapshotable effects. */
export async function processCachedEvaluation<T>(
  options: Options,
  session: DefineRulesRegistrySession,
  consume: (source: string) => T | Promise<T>
): Promise<T> {
  const execution = currentCompilationExecution();
  const cache = execution?.compilationCache;

  const fresh = () => processVanillaWithExecution(options, consume);

  if (
    !cache ||
    !cache.evaluationResults ||
    !execution?.cacheEnabled ||
    execution.evaluation === "fresh" ||
    typeof options.identOption === "function"
  )
    return fresh();

  return cache.withInputs(async () => {
    const proof = proveReusableEvaluation(options.source, cache.parser);

    if (!proof) {
      recordCompilationDiagnostic("evaluation-result-bypass", {
        reason: "unproved-inputs"
      });

      return fresh();
    }

    const require = createRequire(resolve(options.filePath));
    let dependencies: string[];

    try {
      dependencies = proof.modules.map((name) => require.resolve(name));

      // CommonJS entry shims select sibling production/development chunks.
      // Track those implementations as well as the shim and package metadata.
      const directories = await cache.fingerprint(
        new Set(dependencies.map(dirname))
      );

      const libraryKey = `evaluation-libraries:${cacheDigest(JSON.stringify([...directories]))}`;
      let siblings = cache.parser.get<readonly string[]>(libraryKey);

      if (!siblings) {
        siblings = Object.freeze(
          (
            await Promise.all(
              [...directories.keys()].map(async (directory) =>
                (await readdir(directory))
                  .filter((file) => /\.[cm]?js$/.test(file))
                  .map((file) => join(directory, file))
              )
            )
          ).flat()
        );
        cache.parser.set(
          libraryKey,
          siblings,
          Buffer.byteLength(JSON.stringify(siblings))
        );
      }

      dependencies.push(...directories.keys(), ...siblings);
    } catch {
      return fresh();
    }

    const inputs = await cache.fingerprint([
      ...dependencies,
      // A closed program only uses the resolved implementation files. Library
      // Babel/TS configuration is not executed; owner resolution stays tracked.
      ...cache.configurationFiles([options.filePath])
    ]);

    let identity: string;

    try {
      identity = await getCompilerIdentity();
    } catch {
      recordCompilationDiagnostic("evaluation-result-bypass", {
        reason: "compiler-identity-unavailable"
      });

      return fresh();
    }

    const key = `evaluation-result:${cacheDigest(
      JSON.stringify([
        identity,
        options.source,
        options.filePath,
        options.outputCss ?? true,
        options.identOption,
        evaluationEnvironment(),
        [...inputs]
      ])
    )}`;

    let created: { result: T } | undefined;
    const value = await cache.run<EvaluationResult | null>(key, async () => {
      let vanilla: SerializedVanillaEvaluation | undefined;
      let registry: RegistrySnapshot | undefined;
      const result = await processVanillaWithExecution(options, consume, {
        beforeSerialize() {
          try {
            registry = snapshotRegistry(session);
          } catch {
            /* Opaque configuration must execute on each request. */
          }
        },

        complete(value) {
          vanilla = value;
        }
      });

      created = { result };

      const value = vanilla && registry ? { vanilla, registry } : null;

      if (!value)
        recordCompilationDiagnostic("evaluation-result-bypass", {
          reason: "unserializable-effects-or-incompatible-protocol"
        });

      return {
        value,
        owner: options.filePath,
        dependencies: [...inputs.keys()],
        bytes: value ? Buffer.byteLength(JSON.stringify(value)) : Infinity,
        manifest: { fingerprints: [...inputs] },

        valid: () => cache.unchanged(inputs)
      };
    });
    if (created) return created.result;
    if (!value) return fresh();

    recordCompilationDiagnostic("evaluation-result-hit");

    return measureCompilationPhase("evaluation-replay", async () => {
      const registry = structuredClone(value.registry);
      session.nextRegistrationIndex = registry.nextRegistrationIndex;
      session.nextRegistrationIndexByFileScope =
        registry.nextRegistrationIndexByFileScope;
      session.instances = registry.instances.map((instance) => ({
        ...instance,

        getPresetSnapshot: () => structuredClone(instance.presetArtifact)
      }));

      return consume(await replayVanillaEvaluation(options, value.vanilla));
    });
  });
}
