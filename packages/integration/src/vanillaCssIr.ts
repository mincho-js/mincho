/** Vanilla-extract 1.20.1 adapter data, before CSS serialization. */
import type { Adapter, FileScope } from "@vanilla-extract/css";
import { createHash } from "node:crypto";
import { setAdapter, removeAdapter } from "@vanilla-extract/css/adapter";
import { transformCss } from "@vanilla-extract/css/transformCss";
import type { CompilerStyleResources } from "@mincho-js/css/defineRules/registry";

/** Compiler use proof, kept separate from CSS content identity. Null pins all selections. */
export interface PrivateRecipeUse {
  id: string;
  used: readonly string[] | null;
}

export interface VanillaCssArtifact {
  /** Absolute authoring file, used for URL/PostCSS resolution at output time. */
  origin: string;
  fileScope: FileScope;
  cssObjs: Parameters<Adapter["appendCss"]>[0][];
  localClassNames: string[];
  composedClassLists: Parameters<Adapter["registerComposition"]>[0][];
  usedCompositions: string[];

  /** References visible to runtime consumers; absent metadata is opaque. */
  provenance?: {
    version: 1;
    publicReferences: readonly string[];
    generatedVariables: readonly string[];
    opaque: boolean;
    resources?: CompilerStyleResources & {
      publicKeyframes: readonly string[];
      publicFonts?: readonly string[];
      recipeUses?: readonly PrivateRecipeUse[];
    };
  };
}

/** JSON's default NaN/Infinity/null and omitted-undefined collisions are unsafe
 * for CSS custom-property token streams. Escape every string before using
 * distinct scalar tags, so author strings cannot collide with internal tags.
 */
export function hashVanillaCssArtifact(artifact: VanillaCssArtifact): string {
  // Consumer export metadata is merged by owner separately. It must not give
  // identical provider CSS multiple module identities or change its load order.
  const { provenance: _provenance, ...css } = artifact;
  const value = JSON.stringify(css, (_key, item: unknown) => {
    if (typeof item === "string") return `\0s${item}`;
    if (item === undefined) return "\0u";
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) || Object.is(item, -0))
    )
      return `\0n${Object.is(item, -0) ? "-0" : String(item)}`;
    if (typeof item === "bigint") return `\0i${item}`;

    return item;
  });

  return createHash("sha256")
    .update("css-ir-identity-v2\0")
    .update(value)
    .digest("hex");
}

/** Record references before CSS imports are appended to serialized exports.
 * All scopes share the export surface: a consumer can expose a provider's var.
 * Escaped identifiers are deliberately opaque rather than incompletely parsed.
 */
export function annotateVanillaCssArtifacts(
  artifacts: readonly VanillaCssArtifact[],
  serializedExports: readonly string[],
  generatedVariables: readonly string[] = [],
  resources?: CompilerStyleResources
): void {
  const references = new Set<string>();
  const resourceReferences = new Set<string>();
  let opaque = false;
  let resourcesOpaque = false;

  for (const source of serializedExports) {
    if (/\\(?:u|x)/.test(source)) opaque = true;
    else if (source.includes("\\")) resourcesOpaque = true;

    for (const match of source.matchAll(/--[A-Za-z_][A-Za-z0-9_-]*/g))
      references.add(match[0]);

    for (const match of source.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g))
      resourceReferences.add(match[0]);
  }

  const provenance = {
    version: 1 as const,
    publicReferences: [...references].sort(),
    generatedVariables: [...generatedVariables].sort(),
    opaque,
    ...(resources?.version === 2 && !resourcesOpaque
      ? {
          resources: {
            version: 2 as const,
            fonts: [...(resources.fonts ?? [])].sort(),
            publicFonts: (resources.fonts ?? []).filter((name) =>
              resourceReferences.has(name)
            ),
            keyframes: [...resources.keyframes].sort(),
            foreignKeyframes: [...(resources.foreignKeyframes ?? [])].sort(),
            recipes: structuredClone(resources.recipes),
            themes: [...resources.themes].sort(),
            publicKeyframes: resources.keyframes.filter((name) =>
              resourceReferences.has(name)
            )
          }
        }
      : {})
  };

  for (const artifact of artifacts) artifact.provenance = provenance;
}

// Evaluation finishes these arrays before either composition pass reads them.
// Weak ownership lets both passes share facts without retaining removed owners.
const selectorFacts = new WeakMap<VanillaCssArtifact["cssObjs"], string[]>();
const compositionFacts = new WeakMap<
  VanillaCssArtifact["composedClassLists"],
  { identifier: string; pattern: RegExp }[]
>();

function selectors(artifact: VanillaCssArtifact): string[] {
  const cached = selectorFacts.get(artifact.cssObjs);
  if (cached) return cached;

  const result: string[] = [];

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "selectors" && child && typeof child === "object")
        result.push(...Object.keys(child));

      visit(child);
    }
  };

  for (const root of artifact.cssObjs) {
    if (root.type !== "local" && root.type !== "global") continue;

    result.push(root.selector);
    visit(root.rule);
  }

  selectorFacts.set(artifact.cssObjs, result);

  return result;
}

function compositions(artifact: VanillaCssArtifact) {
  let cached = compositionFacts.get(artifact.composedClassLists);

  if (!cached) {
    cached = [...artifact.composedClassLists]
      .reverse()
      .map(({ identifier, classList }) => ({
        identifier,
        pattern: new RegExp(`(${classList})`, "g")
      }));
    compositionFacts.set(artifact.composedClassLists, cached);
  }

  return cached;
}

/** Exclude other scopes' registration context from this artifact's identity.
 * The same provider can be evaluated inside several consumers. Only selector
 * references participate in transformCss's class/composition rewriting.
 */
export function isolateVanillaCssArtifact(
  artifact: VanillaCssArtifact
): VanillaCssArtifact {
  const values = selectors(artifact);
  const required = new Set<string>();
  const rewritten = values.map((value) => {
    for (const { identifier, pattern } of compositions(artifact))
      value = value.replace(pattern, () => {
        required.add(identifier);

        return identifier;
      });

    return value;
  });

  return {
    ...artifact,
    localClassNames: artifact.localClassNames.filter((name) =>
      rewritten.some((selector) => selector.includes(name))
    ),
    composedClassLists: artifact.composedClassLists.filter(({ identifier }) =>
      required.has(identifier)
    ),
    usedCompositions: artifact.usedCompositions.filter((identifier) =>
      required.has(identifier)
    )
  };
}

/** Resolve export composition usage without producing CSS during evaluation. */
export function collectSelectorCompositions(
  artifacts: readonly VanillaCssArtifact[],
  used: Set<string>
): void {
  for (const artifact of artifacts) {
    const matches = compositions(artifact);

    const selector = (value: string) => {
      for (const { identifier, pattern } of matches)
        value = value.replace(pattern, () => {
          used.add(identifier);

          return identifier;
        });
    };

    selectors(artifact).forEach(selector);
  }
}

/** Each file is an ordering barrier: conditional rules must not cross it. */
export function generateVanillaCss(artifact: VanillaCssArtifact): string {
  // The upstream serializer mutates rules (notably keyframes). Keep cached IR
  // intact across previews, multiple outputs and watch rebuilds.
  const input = structuredClone(artifact);
  setAdapter({
    appendCss() {},

    registerClassName() {},

    registerComposition() {},

    markCompositionUsed() {},

    onEndFileScope() {},

    getIdentOption: () => "short"
  });

  try {
    return transformCss(input).join("\n");
  } finally {
    removeAdapter();
  }
}
