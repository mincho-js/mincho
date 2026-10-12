/** Vanilla-extract 1.20.1 adapter data, before CSS serialization. */
import type { Adapter, FileScope } from "@vanilla-extract/css";
import { setAdapter, removeAdapter } from "@vanilla-extract/css/adapter";
import { transformCss } from "@vanilla-extract/css/transformCss";

export interface VanillaCssArtifact {
  /** Absolute authoring file, used for URL/PostCSS resolution at output time. */
  origin: string;
  fileScope: FileScope;
  cssObjs: Parameters<Adapter["appendCss"]>[0][];
  localClassNames: string[];
  composedClassLists: Parameters<Adapter["registerComposition"]>[0][];
  usedCompositions: string[];
}

function selectors(artifact: VanillaCssArtifact): string[] {
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

  return result;
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
    for (const { identifier, classList } of [
      ...artifact.composedClassLists
    ].reverse())
      value = value.replace(new RegExp(`(${classList})`, "g"), () => {
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
    const compositions = [...artifact.composedClassLists].reverse();

    const selector = (value: string) => {
      for (const { identifier, classList } of compositions)
        value = value.replace(new RegExp(`(${classList})`, "g"), () => {
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
