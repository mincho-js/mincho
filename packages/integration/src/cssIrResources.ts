import type { VanillaCssArtifact } from "./vanillaCssIr.js";

type RecordValue = Record<string, unknown>;

const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const variable = (value: string) =>
  /^var\((--[\w-]+)\)$/.exec(value)?.[1] ?? value;

const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const animationProperty =
  /^(?:(?:Webkit|Moz|O|ms)|-(?:webkit|moz|o|ms)-)?animation(?:-?name)?$/i;

const cssWide = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const animationKeywords = new Set(
  "none infinite normal reverse alternate alternate-reverse forwards backwards both running paused ease ease-in ease-out ease-in-out linear step-start step-end".split(
    " "
  )
);

/** Names are identified from capture, never their spelling. Unknown grammar pins the graph. */
function animationNames(
  value: unknown,
  shorthand: boolean
): Set<string> | null {
  if (Array.isArray(value)) {
    const result = new Set<string>();

    for (const item of value) {
      const names = animationNames(item, shorthand);
      if (!names) return null;

      for (const name of names) result.add(name);
    }

    return result;
  }

  if (
    typeof value !== "string" ||
    /[\\'";{}]/.test(value) ||
    cssWide.test(value.trim())
  )
    return null;

  if (!shorthand) {
    const names = value.split(",").map((name) => name.trim());

    return names.every((name) => identifier.test(name))
      ? new Set(names.filter((name) => name !== "none"))
      : null;
  }

  // Only known timing functions have comma-bearing bodies. Nested or unknown functions bail out.
  const stripped = value.replace(
    /(?:cubic-bezier|steps)\([\d\s.,+-]*(?:start|end|jump-start|jump-end|jump-none|jump-both)?\)/gi,
    " ease "
  );
  if (/[()]/.test(stripped)) return null;

  const names = new Set<string>();

  for (const item of stripped.split(",")) {
    const tokens = item.trim().split(/\s+/);
    const possible: string[] = [];

    for (const token of tokens) {
      if (
        animationKeywords.has(token.toLowerCase()) ||
        /^[+-]?(?:\d*\.)?\d+(?:ms|s)?$/i.test(token)
      )
        continue;
      if (!identifier.test(token)) return null;

      possible.push(token);
    }

    if (possible.length > 1) return null;

    for (const name of possible) names.add(name);
  }

  return names;
}

const wholeGraphCache = new WeakMap<VanillaCssArtifact["cssObjs"], boolean>();

/** Unknown names can reference any owner; do not partition their liveness analysis. */
export function cssResourcesNeedWholeGraph(
  artifact: VanillaCssArtifact
): boolean {
  const cached = wholeGraphCache.get(artifact.cssObjs);
  if (cached !== undefined) return cached;

  let whole = false;

  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("\\")) whole = true;
    } else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (
          animationProperty.test(key) &&
          !animationNames(child, !/Name$/i.test(key))
        )
          whole = true;

        scan(key);
        scan(child);
      }
  };

  scan(artifact.cssObjs);
  wholeGraphCache.set(artifact.cssObjs, whole);

  return whole;
}

export function prunePrivateCssResources(
  input: ReadonlyMap<string, VanillaCssArtifact>,
  options: { pruneRecipes?: boolean; pruneKeyframes?: boolean },
  external: boolean
) {
  const diagnostics = {
    recipeCandidates: 0,
    recipesApplied: 0,
    recipeBailout: 0,
    removedRecipeRules: 0,
    keyframeCandidates: 0,
    removedKeyframes: 0,
    resourceBailout: "disabled"
  };

  const available = [...input.values()];
  const opaque =
    external ||
    available.some(
      ({ provenance }) =>
        !provenance || provenance.opaque || provenance.resources?.version !== 2
    );
  if (opaque)
    return {
      artifacts: input,
      diagnostics: {
        ...diagnostics,
        resourceBailout: external
          ? "external-css"
          : "missing-or-opaque-provenance"
      }
    };

  const hasRecipes =
    options.pruneRecipes &&
    available.some(
      (artifact) => artifact.provenance!.resources!.recipes.length > 0
    );

  const hasKeyframes =
    options.pruneKeyframes &&
    available.some(
      (artifact) => artifact.provenance!.resources!.keyframes.length > 0
    );
  if (!hasRecipes && !hasKeyframes)
    return {
      artifacts: input,
      diagnostics: { ...diagnostics, resourceBailout: "no-candidates" }
    };

  const recipes = new Map<
    string,
    {
      classes: Set<string>;
      references: Set<string>;
      used: Set<string>;
      private: boolean;
    }
  >();

  for (const artifact of available) {
    const resources = artifact.provenance!.resources!;
    const uses = new Map(
      resources.recipeUses?.map((use) => [use.id, use.used])
    );

    for (const recipe of resources.recipes) {
      const previous = recipes.get(recipe.id) ?? {
        classes: new Set(),
        references: new Set(),
        used: new Set(),
        private: true
      };

      for (const name of recipe.classes) previous.classes.add(name);

      for (const name of recipe.references) previous.references.add(name);

      const used = uses.get(recipe.id);

      if (!used) previous.private = false;
      else for (const name of used) previous.used.add(name);

      recipes.set(recipe.id, previous);
    }
  }

  const candidates = new Set<string>();
  const liveClasses = new Set<string>();

  for (const recipe of recipes.values()) {
    if (recipe.private && options.pruneRecipes) {
      diagnostics.recipesApplied++;

      for (const name of recipe.classes) candidates.add(name);

      for (const name of recipe.used) liveClasses.add(name);
    } else for (const name of recipe.references) liveClasses.add(name);
  }

  diagnostics.recipeCandidates = recipes.size;
  diagnostics.recipeBailout = recipes.size - diagnostics.recipesApplied;

  const pinReferences = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("\\"))
        for (const name of candidates) liveClasses.add(name);
      else
        for (const name of value.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? [])
          if (candidates.has(name)) liveClasses.add(name);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        pinReferences(key);
        pinReferences(child);
      }
    }
  };

  for (const artifact of available) {
    const ownedClasses = new Set(
      artifact.provenance!.resources!.recipes.flatMap(
        (recipe) => recipe.classes
      )
    );

    for (const root of artifact.cssObjs) {
      if (root.type === "local" || root.type === "global") {
        const selector = root.selector.replace(/^\./, "");

        if (!candidates.has(selector) || !ownedClasses.has(selector))
          pinReferences(root.selector);

        pinReferences(root.rule);
      } else pinReferences(root);
    }

    pinReferences(artifact.composedClassLists);
  }

  const deadClasses = new Set(
    [...candidates].filter((name) => !liveClasses.has(name))
  );

  let artifacts: ReadonlyMap<string, VanillaCssArtifact> = deadClasses.size
    ? new Map(
        [...input].map(([id, artifact]) => [
          id,
          {
            ...artifact,
            cssObjs: artifact.cssObjs.filter((root) => {
              if (
                (root.type === "local" || root.type === "global") &&
                deadClasses.has(root.selector.replace(/^\./, ""))
              ) {
                diagnostics.removedRecipeRules++;

                return false;
              }

              return true;
            })
          }
        ])
      )
    : input;

  // No animation proof was performed, so do not claim a closed resource graph
  // for the existing variable-liveness pass when there are no captured frames.
  if (!hasKeyframes) return { artifacts, diagnostics };

  const foreignKeyframes = new Set(
    available.flatMap(
      (artifact) => artifact.provenance!.resources!.foreignKeyframes ?? []
    )
  );

  const keyframes = new Set(
    available
      .flatMap((artifact) => artifact.provenance!.resources!.keyframes)
      .filter((name) => !foreignKeyframes.has(name))
  );

  const generatedVars = new Set(
    available.flatMap((artifact) => [
      ...artifact.provenance!.generatedVariables
    ])
  );

  const definitions = new Map<string, unknown[]>();
  const frames = new Map<string, unknown[]>();
  const liveFrames = new Set(
    available.flatMap((artifact) => [
      ...artifact.provenance!.resources!.publicKeyframes
    ])
  );

  let unknown = false;

  const collectVars = (value: unknown): void => {
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "vars" && object(child))
        for (const [name, assigned] of Object.entries(child)) {
          const id = variable(name);
          definitions.set(id, [...(definitions.get(id) ?? []), assigned]);
        }
      else collectVars(child);
    }
  };

  const scanAnimation = (
    value: unknown,
    shorthand: boolean,
    active = new Set<string>()
  ): void => {
    if (typeof value === "string" && value.includes("var(")) {
      // Only a complete var() token can be proven without a CSS value parser.
      const match = /^var\((--[A-Za-z_][\w-]*)(?:,\s*([^()]*))?\)$/.exec(value);

      if (
        !match ||
        !generatedVars.has(match[1]!) ||
        !definitions.has(match[1]!)
      ) {
        unknown = true;

        return;
      }

      if (active.has(match[1]!)) return;

      const next = new Set(active).add(match[1]!);

      for (const assigned of definitions.get(match[1]!)!)
        scanAnimation(assigned, shorthand, next);

      if (match[2]) scanAnimation(match[2], shorthand, next);

      return;
    }

    const names = animationNames(value, shorthand);

    if (!names) {
      unknown = true;

      return;
    }

    for (const name of names) liveFrames.add(name);
  };

  const scan = (value: unknown): void => {
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (animationProperty.test(key))
        scanAnimation(child, !/Name$/i.test(key));
      else if (key === "vars" && object(child)) {
        // Public/author-owned token streams can name an animation elsewhere.
        for (const [name, assigned] of Object.entries(child))
          if (
            !generatedVars.has(variable(name)) &&
            typeof assigned === "string"
          )
            for (const id of keyframes)
              if (assigned.includes(id)) liveFrames.add(id);
      } else scan(child);
    }
  };

  for (const artifact of artifacts.values()) {
    for (const root of artifact.cssObjs) {
      collectVars(root);

      if (root.type === "property") {
        definitions.set(root.name, [
          ...(definitions.get(root.name) ?? []),
          root.rule.initialValue
        ]);
      }

      if (root.type === "keyframes")
        frames.set(root.name, [...(frames.get(root.name) ?? []), root.rule]);
    }
  }

  // Exported custom properties may be overridden with an arbitrary animation name.
  for (const artifact of artifacts.values())
    for (const name of artifact.provenance!.publicReferences)
      generatedVars.delete(name);

  for (const artifact of artifacts.values())
    for (const root of artifact.cssObjs) {
      if (root.type !== "keyframes" || !keyframes.has(root.name)) scan(root);
    }

  const visited = new Set<string>();

  for (;;) {
    const pending = [...liveFrames].filter((name) => !visited.has(name));
    if (!pending.length) break;

    for (const name of pending) {
      visited.add(name);

      for (const rule of frames.get(name) ?? []) scan(rule);
    }
  }

  diagnostics.keyframeCandidates = keyframes.size;
  diagnostics.resourceBailout = unknown
    ? "opaque-animation-value"
    : "closed-resource-graph";

  if (!unknown)
    artifacts = new Map(
      [...artifacts].map(([id, artifact]) => [
        id,
        {
          ...artifact,
          cssObjs: artifact.cssObjs.filter((root) => {
            if (
              root.type === "keyframes" &&
              keyframes.has(root.name) &&
              !liveFrames.has(root.name)
            ) {
              diagnostics.removedKeyframes++;

              return false;
            }

            return true;
          })
        }
      ])
    );

  return { artifacts, diagnostics };
}
