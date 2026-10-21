import { createHash } from "node:crypto";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";

type RecordValue = Record<string, unknown>;

const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const variable = (name: string) =>
  /^var\((--[\w-]+)\)$/.exec(name)?.[1] ?? name;

/** Deliberately small literal grammar. No context-dependent substitutions or escapes. */
export function isInternableThemeLiteral(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    /[\\;{}![\]]|\/\*|--/.test(value) ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) ||
    /^(?:initial|inherit|unset|revert|revert-layer)$/i.test(value.trim())
  )
    return false;

  const functions = new Set([
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "color",
    "linear-gradient",
    "radial-gradient",
    "conic-gradient",
    "repeating-linear-gradient",
    "repeating-radial-gradient",
    "repeating-conic-gradient",
    "cubic-bezier"
  ]);

  let depth = 0;
  let quote = "";

  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;

    if (quote) {
      if (char === quote) quote = "";

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      const name = /([a-z-]+)$/i
        .exec(value.slice(0, index))?.[1]
        ?.toLowerCase();
      if (!name || !functions.has(name)) return false;

      depth++;
    } else if (char === ")") {
      if (--depth < 0) return false;
    } else if (!/[\p{L}\p{N}\s#%,.+/-]/u.test(char)) return false;
  }

  return !quote && depth === 0 && !!value.trim();
}

/** Helpers are declared in each original block, so inheritance and token overrides stay local. */
export function internThemeValues(
  artifact: VanillaCssArtifact,
  reserved: ReadonlySet<string>,
  registered: ReadonlySet<string>,
  generatedHelpers = new Map<string, string>()
) {
  const themes = new Set(
    artifact.provenance?.resources?.version === 2
      ? artifact.provenance.resources.themes
      : []
  );

  let candidates = 0;
  let applied = 0;
  let savedBytes = 0;
  let addedBytes = 0;
  let result = artifact;

  const visit = (
    rule: unknown,
    path: readonly string[],
    rootIndex: number
  ): unknown => {
    if (!object(rule)) return rule;

    let next = rule;

    if (object(rule.vars)) {
      const groups = new Map<string, string[]>();

      for (const [key, value] of Object.entries(rule.vars)) {
        if (registered.has(variable(key)) || !isInternableThemeLiteral(value))
          continue;

        const keys = groups.get(value) ?? [];
        keys.push(key);
        groups.set(value, keys);
      }

      for (const [value, keys] of groups) {
        if (keys.length < 2) continue;

        candidates++;

        const name = `--mi-${createHash("sha256")
          .update(
            JSON.stringify([
              "theme-literals-v1",
              artifact.origin,
              artifact.fileScope,
              path,
              value
            ])
          )
          .digest("hex")
          .slice(0, 10)}`;

        const identity = JSON.stringify([path, value]);
        if (
          reserved.has(name) ||
          (generatedHelpers.has(name) &&
            generatedHelpers.get(name) !== identity)
        )
          continue;

        const vars = { ...(next.vars as RecordValue), [name]: value };

        for (const key of keys) vars[key] = `var(${name})`;

        // Include real serializer whitespace, UTF-8, helper names and declarations.
        const sample = (candidate: unknown) => {
          for (let index = path.length - 2; index >= 0; index -= 2)
            candidate = { [path[index]!]: { [path[index + 1]!]: candidate } };

          return generateVanillaCss({
            ...artifact,
            cssObjs: [
              {
                ...artifact.cssObjs[rootIndex]!,
                rule: candidate
              } as VanillaCssArtifact["cssObjs"][number]
            ]
          });
        };

        const candidate = { ...next, vars };
        const before = Buffer.byteLength(sample(next));
        const after = Buffer.byteLength(sample(candidate));
        if (after >= before) continue;

        addedBytes += Buffer.byteLength(`${name}: ${value};\n`);
        savedBytes += before - after;
        applied++;
        generatedHelpers.set(name, identity);
        next = candidate;
      }
    }

    for (const condition of ["@layer", "@media", "@supports"]) {
      const children = next[condition];
      if (!object(children)) continue;

      next = {
        ...next,
        [condition]: Object.fromEntries(
          Object.entries(children).map(([key, child]) => [
            key,
            visit(child, [...path, condition, key], rootIndex)
          ])
        )
      };
    }

    return next;
  };

  const roots = artifact.cssObjs.map((root, index) => {
    if (
      (root.type !== "global" && root.type !== "local") ||
      !themes.has(root.selector.replace(/^\./, ""))
    )
      return root;

    return { ...root, rule: visit(root.rule, [], index) } as typeof root;
  });

  if (applied) result = { ...artifact, cssObjs: roots };

  return {
    artifact: result,
    diagnostics: {
      candidates,
      applied,
      bailout: candidates - applied,
      savedBytes,
      addedBytes
    }
  };
}
