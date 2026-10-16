import type { VanillaCssArtifact } from "./vanillaCssIr.js";

type CssObject = VanillaCssArtifact["cssObjs"][number];

type RecordValue = Record<string, unknown>;

export interface CssIrOptimizationOptions {
  mergeRules: boolean;
  pruneGenerated: boolean;
  compactThemes: boolean;
}

interface Facts {
  references: Set<string>;
  definitions: Map<string, Set<string>>;
  inherited: Set<string>;
  opaque: boolean;
}

const factsCache = new WeakMap<VanillaCssArtifact["cssObjs"], Facts>();

const variable = (value: string) =>
  /^(--[A-Za-z_][A-Za-z0-9_-]*)$/.exec(value)?.[1] ??
  /^var\((--[A-Za-z_][A-Za-z0-9_-]*)\)$/.exec(value)?.[1];

const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function facts(artifact: VanillaCssArtifact): Facts {
  const cached = factsCache.get(artifact.cssObjs);
  if (cached) return cached;

  const result: Facts = {
    references: new Set(),
    definitions: new Map(),
    inherited: new Set(),
    opaque: false
  };

  const scan = (
    value: unknown,
    into: Set<string>,
    preserveDefinitions = false
  ) => {
    if (typeof value === "string") {
      // Escapes can hide a var name. Never make a partial liveness decision.
      if (value.includes("\\")) result.opaque = true;

      for (const match of value.matchAll(/--[A-Za-z_][A-Za-z0-9_-]*/g))
        into.add(match[0]);
    } else if (Array.isArray(value)) {
      for (const child of value) scan(child, into, preserveDefinitions);
    } else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        // Removing a registered property's transitions can change event delivery.
        if (/^(?:animation|transition)/i.test(key)) result.opaque = true;

        if (key === "vars" && object(child)) {
          for (const [name, assigned] of Object.entries(child)) {
            const id = variable(name);

            if (!id) {
              result.opaque = true;
              continue;
            }

            const refs = result.definitions.get(id) ?? new Set<string>();

            if (preserveDefinitions) result.references.add(id);

            scan(assigned, refs);
            result.definitions.set(id, refs);
          }
        } else {
          scan(key, into);
          scan(child, into, preserveDefinitions || key === "@layer");
        }
      }
    }
  };

  for (const root of artifact.cssObjs) {
    if (root.type === "property") {
      if (root.rule.inherits !== "false") result.inherited.add(root.name);

      const refs = result.definitions.get(root.name) ?? new Set<string>();
      scan(root.rule, refs);
      result.definitions.set(root.name, refs);
    } else
      scan(
        root,
        result.references,
        root.type !== "local" && root.type !== "global"
      );
  }

  factsCache.set(artifact.cssObjs, result);

  return result;
}

/** Closed resource graph. Missing export provenance or opaque CSS is a barrier. */
function deadVariables(artifacts: readonly VanillaCssArtifact[]) {
  const candidates = new Set<string>();
  const live = new Set<string>();
  const edges = new Map<string, Set<string>>();

  for (const artifact of artifacts) {
    const provenance = artifact.provenance;
    const info = facts(artifact);
    if (!provenance || provenance.opaque || info.opaque)
      return { dead: new Set<string>(), reason: "opaque-resource-references" };

    for (const name of provenance.generatedVariables) candidates.add(name);

    for (const name of provenance.publicReferences) live.add(name);

    for (const name of info.references) live.add(name);

    for (const name of info.inherited) live.add(name);

    for (const [name, refs] of info.definitions) {
      const target = edges.get(name) ?? new Set<string>();

      for (const ref of refs) target.add(ref);

      edges.set(name, target);
    }
  }

  // Author-owned/public definitions may be consumed outside the compiler graph.
  for (const name of edges.keys()) if (!candidates.has(name)) live.add(name);

  const queue = [...live];

  for (let index = 0; index < queue.length; index++)
    for (const ref of edges.get(queue[index]!) ?? [])
      if (!live.has(ref)) {
        live.add(ref);
        queue.push(ref);
      }

  return {
    dead: new Set([...candidates].filter((name) => !live.has(name))),
    reason: "closed-resource-graph"
  };
}

function prune(value: unknown, dead: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((child) => prune(child, dead));
  if (!object(value)) return value;

  const result: RecordValue = {};

  for (const [key, child] of Object.entries(value)) {
    if (key === "vars" && object(child)) {
      const kept = Object.fromEntries(
        Object.entries(child).filter(([name]) => !dead.has(variable(name)!))
      );

      if (Object.keys(kept).length) result[key] = kept;
    } else result[key] = prune(child, dead);
  }

  return result;
}

const scalar = (value: unknown) =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

function flatRule(value: unknown): value is RecordValue {
  if (!object(value) || !Object.keys(value).length) return false;

  return Object.entries(value).every(([key, child]) => {
    if (key === "vars")
      return object(child) && Object.values(child).every(scalar);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || key === "composes") return false;

    return scalar(child) || (Array.isArray(child) && child.every(scalar));
  });
}

function localSelector(
  root: CssObject,
  names: ReadonlySet<string>
): string | undefined {
  if (root.type !== "local" && root.type !== "global") return;

  const name = root.selector.startsWith(".")
    ? root.selector.slice(1)
    : root.selector;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || !names.has(name)) return;

  // Vanilla-extract resolves registered identifiers in global selectors.
  return name;
}

/** Preserve file order, declaration/fallback order, conditions and class names. */
export function optimizeVanillaCssArtifacts(
  input: ReadonlyMap<string, VanillaCssArtifact>,
  options: CssIrOptimizationOptions,
  externalCss = false
) {
  const liveness =
    options.pruneGenerated && !externalCss
      ? deadVariables([...input.values()])
      : {
          dead: new Set<string>(),
          reason: externalCss ? "external-css" : "disabled"
        };

  const artifacts = new Map<string, VanillaCssArtifact>();
  let removedRules = 0;
  let mergedRules = 0;

  for (const [id, artifact] of input) {
    let roots: CssObject[] = [];

    for (const root of artifact.cssObjs) {
      if (
        root.type === "property" &&
        root.rule.inherits === "false" &&
        liveness.dead.has(root.name)
      ) {
        removedRules++;
        continue;
      }

      const next =
        liveness.dead.size && (root.type === "local" || root.type === "global")
          ? (prune(root, liveness.dead) as CssObject)
          : root;

      if (
        (next.type === "local" || next.type === "global") &&
        "rule" in root &&
        Object.keys(root.rule).length &&
        !Object.keys(next.rule).length
      ) {
        removedRules++;
        continue;
      }

      roots.push(next);
    }

    if (options.mergeRules || options.compactThemes) {
      const merged: CssObject[] = [];
      const names = new Set(artifact.localClassNames);
      let previous: { signature: string; selectors: string[] } | undefined;

      for (const root of roots) {
        const selector = localSelector(root, names);
        const rule = "rule" in root ? root.rule : undefined;
        const theme =
          object(rule) && Object.keys(rule).every((key) => key === "vars");

        const signature =
          selector &&
          flatRule(rule) &&
          (theme ? options.compactThemes : options.mergeRules)
            ? JSON.stringify(rule)
            : undefined;

        if (signature && previous?.signature === signature) {
          if (!previous.selectors.includes(selector!))
            previous.selectors.push(selector!);

          merged[merged.length - 1] = {
            type: "global",
            selector: previous.selectors.join(", "),
            rule: rule as Extract<CssObject, { type: "global" }>["rule"]
          };
          mergedRules++;
        } else {
          merged.push(root);
          previous = signature
            ? { signature, selectors: [selector!] }
            : undefined;
        }
      }

      roots = merged;
    }

    artifacts.set(id, { ...artifact, cssObjs: roots });
  }

  return {
    artifacts,
    diagnostics: {
      removedVariables: liveness.dead.size,
      removedRules,
      mergedRules,
      liveness: liveness.reason
    }
  };
}
