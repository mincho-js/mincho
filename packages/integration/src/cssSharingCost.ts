import {
  measureBundleBytes,
  bundleSizeMetric,
  type BundleSizeOptions
} from "./bundleSize.js";
import type { CssSharingBoundary } from "./cssChunkSharing.js";

export interface CssSharingCostDecision {
  applied: boolean;
  metric: NonNullable<BundleSizeOptions["metric"]>;
  scenarios: {
    entry: string;
    visits: { id: string; before: number; after: number; increase: number }[];
  }[];
  estimate: true;
  reason:
    "compressed-transfer-win" | "initial-or-route-cost" | "no-route-visits";
}

export interface CssSharingCostOptions {
  boundaries: readonly CssSharingBoundary[];
  sources: ReadonlyMap<string, string>;
  shared: readonly string[];
  scenarios: readonly { entry: string; boundaries: readonly string[] }[];
  maxInitialIncreaseBytes?: number;
  bundleSize?: BundleSizeOptions;
}

/** Prepare invariant costs once for one immutable build's sources and boundaries. */
export function createCssSharingCostEvaluator(
  options: Omit<CssSharingCostOptions, "shared">
) {
  const metric = bundleSizeMetric(options.bundleSize);
  // Charge JS, HTML linkage and manifest metadata as separate assets. Some
  // outputs need only a subset, so this deliberately overestimates that cost.
  const overhead = [
    'import "./mincho-shared-000000000000.css";',
    '<link rel="stylesheet" crossorigin href="/assets/mincho-shared-000000000000.css">',
    '{"css":["assets/mincho-shared-000000000000.css"],"imports":["mincho-shared-000000000000"]}'
  ].reduce((bytes, source) => bytes + measureBundleBytes(source)[metric], 0);
  const boundaryCosts = new Map<string, number>();
  const measureBoundary = (ids: readonly string[]) => {
    const key = JSON.stringify(ids);
    const cached = boundaryCosts.get(key);
    if (cached !== undefined) return cached;
    const source = ids.map((id) => options.sources.get(id) ?? "").join("\n");
    const bytes = source.trim() ? measureBundleBytes(source)[metric] : 0;
    boundaryCosts.set(key, bytes);
    return bytes;
  };
  const boundaries = options.boundaries.map((boundary) => ({
    ...boundary,
    before: measureBoundary(boundary.modules)
  }));
  return (sharedIds: readonly string[]): CssSharingCostDecision => {
    const shared = new Set(sharedIds);
    const source = sharedIds
      .map((id) => options.sources.get(id) ?? "")
      .join("\n");
    const sharedCost = source ? measureBundleBytes(source)[metric] : 0;
    const costs = new Map(
      boundaries.map((boundary) => {
        const after = measureBoundary(
          boundary.modules.filter((id) => !shared.has(id))
        );
        const uses = boundary.modules.some((id) => shared.has(id));
        return [
          boundary.id,
          {
            before: boundary.before,
            after: after + (uses ? overhead : 0),
            uses
          }
        ];
      })
    );
    let applied = !!options.scenarios.length;
    let improves = false;
    const scenarios = options.scenarios.map((scenario) => {
      let before = 0,
        after = 0,
        loaded = false;
      const visits = [...new Set([scenario.entry, ...scenario.boundaries])].map(
        (id, index) => {
          const cost = costs.get(id);
          if (!cost) throw new Error(`Unknown CSS sharing boundary: ${id}`);
          before += cost.before;
          after += cost.after + (cost.uses && !loaded ? sharedCost : 0);
          loaded ||= cost.uses;
          const increase = after - before;
          if (
            index === 0
              ? increase > (options.maxInitialIncreaseBytes ?? 0)
              : increase > 0
          )
            applied = false;
          if (index > 0 && increase < 0) improves = true;
          return { id, before, after, increase };
        }
      );
      return { entry: scenario.entry, visits };
    });
    return {
      applied: applied && improves,
      metric,
      scenarios,
      estimate: true,
      reason:
        applied && improves
          ? "compressed-transfer-win"
          : applied &&
              scenarios.every((scenario) => scenario.visits.length <= 1)
            ? "no-route-visits"
            : "initial-or-route-cost"
    };
  };
}

/** Per-asset compression, cold entries and cumulative route visits with a warm cache. */
export function evaluateCssSharingCost(
  options: CssSharingCostOptions
): CssSharingCostDecision {
  return createCssSharingCostEvaluator(options)(options.shared);
}
