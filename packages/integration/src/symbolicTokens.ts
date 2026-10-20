import { types as t } from "@babel/core";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { internalParseModuleProgram } from "@mincho-js/babel";
import { cacheDigest } from "./compilationCache.js";
import { getCompilerIdentity } from "./diskCache.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";
import type { StaticCssEvalSourceProvider } from "./babel.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Rollup rewrites import.meta.url for the CommonJS build.
const ownRequire = createRequire(import.meta.url);

export function compatibleTokenProducer(file: string): boolean {
  const name = "@mincho-js/css/defineRules/registry";

  try {
    return (
      createRequire(resolve(file)).resolve(name) === ownRequire.resolve(name)
    );
  } catch {
    return false;
  }
}

/** Build-only DTO. Never emitted into the application or accepted from source comments. */
export interface SymbolicTokenArtifact {
  version: 1;
  compiler: string;
  producer: string;
  sourceHash: string;
  references: Record<string, string>;
}

export function createSymbolicTokenArtifact(
  source: string,
  producer: string,
  compiler: string,
  captured: ReadonlySet<string>
): SymbolicTokenArtifact | undefined {
  if (!captured.size) return;

  const program = internalParseModuleProgram(producer, source);
  const references: Record<string, string> = Object.create(null);

  for (const statement of program.get("body")) {
    if (!statement.isExportNamedDeclaration() || statement.node.source)
      continue;

    const declaration = statement.get("declaration");

    if (declaration.isVariableDeclaration()) {
      for (const entry of declaration.node.declarations)
        if (
          t.isIdentifier(entry.id) &&
          program.scope.getBinding(entry.id.name)?.constant &&
          t.isStringLiteral(entry.init) &&
          captured.has(entry.init.value)
        )
          references[entry.id.name] = entry.init.value;
    }

    for (const specifier of statement.node.specifiers) {
      if (!t.isExportSpecifier(specifier)) continue;

      const binding = program.scope.getBinding(specifier.local.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) continue;

      const init = binding.path.node.init;

      if (t.isStringLiteral(init) && captured.has(init.value))
        references[
          t.isIdentifier(specifier.exported)
            ? specifier.exported.name
            : specifier.exported.value
        ] = init.value;
    }
  }

  if (!Object.keys(references).length || Object.keys(references).length > 4096)
    return;

  return {
    version: 1,
    compiler,
    producer,
    sourceHash: cacheDigest(source),
    references
  };
}

/** Only adapters may rebind an artifact after adding their CSS side-effect imports. */
export function rebindSymbolicTokenArtifact(
  artifact: SymbolicTokenArtifact | undefined,
  source: string
): SymbolicTokenArtifact | undefined {
  return artifact
    ? { ...artifact, sourceHash: cacheDigest(source) }
    : undefined;
}

export function tokenReferenceProvider(
  provider: StaticCssEvalSourceProvider
): StaticCssEvalSourceProvider {
  return {
    ...provider,

    async tokenReference(id, name, value) {
      // Always load: provider ownership publishes this generation's CSS, even on hits.
      const loaded = await provider.load(id);
      const artifact = loaded?.symbolicTokens;
      const source = loaded?.sourceText ?? loaded?.source;
      if (
        !artifact ||
        artifact.version !== 1 ||
        !source ||
        artifact.sourceHash !== cacheDigest(source) ||
        artifact.compiler !== (await getCompilerIdentity())
      )
        return null;

      const reference =
        name !== undefined
          ? Object.hasOwn(artifact.references, name)
            ? artifact.references[name]
            : undefined
          : Object.values(artifact.references).find((entry) => entry === value);

      recordCompilationDiagnostic("symbolic-token-reference", () => ({
        producer: artifact.producer,
        name,
        applied: reference !== undefined
      }));

      return typeof reference === "string" &&
        /^var\(--[A-Za-z_][A-Za-z0-9_-]*\)$/.test(reference)
        ? {
            value: reference,
            identity: JSON.stringify([
              artifact.version,
              artifact.compiler,
              artifact.producer,
              artifact.references
            ])
          }
        : null;
    }
  };
}
