import { compactColorThemes, type ColorThemeContract } from "./colorThemes.js";
import { dedupeCssResources } from "./cssResourceDeduplication.js";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";
import {
  measureBundleBytes,
  bundleSizeMetric,
  type BundleSizeOptions
} from "./bundleSize.js";

type Root = VanillaCssArtifact["cssObjs"][number];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** One path of ordered conditions. Siblings, selector nesting and URLs are barriers. */
function eligibleRule(value: unknown): boolean {
  if (!object(value) || !Object.keys(value).length) return false;
  const entries = Object.entries(value);
  if (
    entries.length === 1 &&
    ["@media", "@supports", "@layer"].includes(entries[0][0])
  ) {
    const branch = entries[0][1];
    return (
      object(branch) &&
      Object.keys(branch).length === 1 &&
      eligibleRule(Object.values(branch)[0])
    );
  }
  return entries.every(([name, item]) => {
    if (name === "vars")
      return object(item) && Object.values(item).every(scalar);
    return (
      /^[A-Za-z][A-Za-z0-9]*$/.test(name) &&
      name !== "composes" &&
      (scalar(item) || (Array.isArray(item) && item.every(scalar)))
    );
  });
}

function scalar(value: unknown) {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && !/url\s*\(|\\/i.test(value))
  );
}

function selector(
  root: Root | undefined,
  artifact: VanillaCssArtifact
): string | undefined {
  if (!root || (root.type !== "local" && root.type !== "global")) return;
  const name = root.selector.replace(/^\./, "");
  if (
    /^[A-Za-z_][\w-]*$/.test(name) &&
    artifact.localClassNames.includes(name) &&
    eligibleRule(root.rule)
  )
    return name;
}

/** Actual final-chunk order; undefined entries are native CSS/order barriers. */
export function optimizeCssChunk(
  input: readonly (VanillaCssArtifact | undefined)[],
  options: {
    crossFileRules?: boolean;
    dedupeResources?: boolean;
    bundleSize?: BundleSizeOptions;
    observed?: boolean;
    opaqueTransform?: boolean;
    opaqueResources?: boolean;
    outsideResources?: ReadonlySet<string>;
    compactColorThemes?: boolean;
    colorThemes?: ColorThemeContract;
  }
) {
  let artifacts = input.map(
    (artifact) => artifact && structuredClone(artifact)
  );
  const diagnostics = {
    estimate: true,
    candidates: 0,
    applied: 0,
    bailout: 0,
    reason: "no-candidates",
    // Keep the diagnostics shape compatible with the stacked color-theme pass.
    colorThemes: undefined as { applied: number; reason: string } | undefined
  };
  if (options.observed || options.opaqueTransform)
    return {
      artifacts: input,
      diagnostics: {
        ...diagnostics,
        reason: options.observed ? "observed-cssom" : "opaque-css-transform"
      }
    };
  const metric = bundleSizeMetric(options.bundleSize);
  const rendered = new WeakMap<VanillaCssArtifact, string>();
  const css = (artifact: VanillaCssArtifact) => {
    let value = rendered.get(artifact);
    if (value === undefined) {
      value = generateVanillaCss(artifact);
      rendered.set(artifact, value);
    }
    return value;
  };
  const cost = (...values: VanillaCssArtifact[]) =>
    measureBundleBytes(values.map(css).join("\n"))[metric];
  if (options.crossFileRules) {
    for (let index = 1; index < artifacts.length; index++) {
      const left = artifacts[index - 1],
        right = artifacts[index];
      if (!left || !right || left.origin === right.origin) continue;
      const a = left.cssObjs.at(-1),
        b = right.cssObjs[0];
      const aName = selector(a, left),
        bName = selector(b, right);
      if (
        !aName ||
        !bName ||
        !a ||
        !b ||
        !("rule" in a) ||
        !("rule" in b) ||
        JSON.stringify(a.rule) !== JSON.stringify(b.rule)
      )
        continue;
      // The serializer emits plain rules before conditions and can regroup
      // queries. Array boundaries alone do not prove emitted adjacency.
      const leftCss = css(left),
        rightCss = css(right);
      const aCss =
          left.cssObjs.length === 1 ? leftCss : css({ ...left, cssObjs: [a] }),
        bCss =
          right.cssObjs.length === 1
            ? rightCss
            : css({ ...right, cssObjs: [b] });
      if (
        !aCss ||
        !bCss ||
        !leftCss.endsWith(aCss) ||
        !rightCss.startsWith(bCss)
      )
        continue;
      const nextLeft = {
        ...left,
        localClassNames: [...new Set([...left.localClassNames, bName])],
        cssObjs: [
          ...left.cssObjs.slice(0, -1),
          {
            type: "global" as const,
            selector: `${aName}, ${bName}`,
            rule: a.rule as Extract<Root, { type: "global" }>["rule"]
          }
        ]
      };
      const nextRight = { ...right, cssObjs: right.cssObjs.slice(1) };
      const mergedCss = css({
        ...nextLeft,
        cssObjs: [nextLeft.cssObjs.at(-1)!]
      });
      // Removing a boundary must not reorder or rewrite any remaining CSS.
      if (
        css(nextLeft) !== leftCss.slice(0, -aCss.length) + mergedCss ||
        css(nextRight) !== rightCss.slice(bCss.length).replace(/^\n/, "")
      )
        continue;
      diagnostics.candidates++;
      const before = cost(left, right);
      if (cost(nextLeft, nextRight) >= before) {
        diagnostics.bailout++;
        continue;
      }
      artifacts[index - 1] = nextLeft;
      artifacts[index] = nextRight;
      diagnostics.applied++;
    }
  }
  // Native/opaque CSS may refer to resources, but it is only an ordering
  // barrier for adjacent rule grouping. Keep all resource rewrites behind this.
  if (options.opaqueResources)
    return {
      artifacts,
      diagnostics: {
        ...diagnostics,
        reason: diagnostics.applied ? "estimated-chunk-win" : "opaque-resources"
      }
    };
  if (options.dedupeResources) {
    const result = dedupeCssResources(
      artifacts,
      options.outsideResources ?? new Set(),
      options.bundleSize
    );
    artifacts = [...result.artifacts];
    diagnostics.candidates += result.diagnostics.candidates;
    diagnostics.applied += result.diagnostics.applied;
    diagnostics.bailout += result.diagnostics.bailout;
  }
  if (options.compactColorThemes) {
    const result = compactColorThemes(
      artifacts,
      options.colorThemes,
      options.bundleSize
    );
    artifacts = [...result.artifacts];
    diagnostics.applied += result.applied;
    diagnostics.colorThemes = {
      applied: result.applied,
      reason: result.reason
    };
  }
  diagnostics.reason = diagnostics.applied
    ? "estimated-chunk-win"
    : diagnostics.candidates
      ? "no-size-win"
      : "no-candidates";
  return { artifacts, diagnostics };
}
