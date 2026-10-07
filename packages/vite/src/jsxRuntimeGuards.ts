import { createHash } from "node:crypto";
import {
  internalHasExplicitJsxRuntimeImport,
  internalTransformJsxRuntimeGuards,
  internalResolveOptimizationOptions
} from "@mincho-js/integration";
import type { Plugin } from "vite";
import type { MinchoVitePluginOptions } from "./index.js";

const script = /\.[cm]?[jt]sx?(?:$|\?)/;
const guardedRuntime = /@mincho-js\/react\/jsx(?:-dev)?-runtime/;
const safeNativeTail = new Set([
  "vite:import-analysis",
  "vite:build-import-analysis",
  "vite:css-analysis",
  "vite:client-inject"
]);

const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");

/** Keep original-source provenance separate from the later JSX transform. */
export function createJsxRuntimeGuardPlugins(
  options: MinchoVitePluginOptions
): {
  evidence: Plugin;
  guard: Plugin;
} {
  const originals = new Map<string, Map<string, boolean | undefined>>();
  let enabled = false;
  let lastTransform = true;
  let injectsNodeEnv = false;
  const evidence: Plugin = {
    name: "mincho:jsx-runtime-provenance",
    enforce: "pre",

    configResolved(config) {
      enabled =
        internalResolveOptimizationOptions(
          options.optimizationMode ??
            (config.command === "build" ? "production" : "development"),
          options.babel?.optimize,
          options.optimize
        ).jsxRuntimeGuards === true;
    },

    buildStart() {
      originals.clear();
    },

    transform(source, id) {
      if (!enabled || id.startsWith("\0") || !script.test(id)) return null;

      const key = `${this.environment?.name ?? "client"}:${id}`;
      let records = originals.get(key);

      if (!records) {
        records = new Map();
        originals.set(key, records);
      }

      const hash = digest(source);

      if (!records.has(hash)) records.set(hash, undefined);

      // Old in-flight generations that are evicted simply retain their guards.
      while (records.size > 4) records.delete(records.keys().next().value!);

      return null;
    },

    closeBundle() {
      originals.clear();
    }
  };

  const guard: Plugin = {
    name: "mincho:jsx-runtime-guards",
    enforce: "post",

    configResolved(config) {
      injectsNodeEnv = false;

      const index = config.plugins.indexOf(guard);
      lastTransform =
        index !== -1 &&
        !config.plugins.some((plugin, position) => {
          const transform = plugin.transform;
          if (!transform || plugin === guard) return false;

          const order =
            typeof transform === "object" ? transform.order : undefined;

          const follows =
            order === "post" || (position > index && order !== "pre");

          if (follows && plugin.name === "vite:client-inject")
            injectsNodeEnv = true;

          return follows && !safeNativeTail.has(plugin.name);
        });
    },

    transform(source, id) {
      if (
        !enabled ||
        !lastTransform ||
        !guardedRuntime.test(source) ||
        // Serve-mode define expressions are substituted by a later native hook.
        (injectsNodeEnv && source.includes("process.env.NODE_ENV"))
      )
        return null;

      const records = originals.get(
        `${this.environment?.name ?? "client"}:${id}`
      );
      if (!records) return null;

      // Read the map for this transform invocation, never the latest code for id.
      // Missing maps or mismatched provenance are deliberately conservative.
      let contents: (string | null)[] | undefined;

      try {
        contents = this.getCombinedSourcemap().sourcesContent;
      } catch {
        return null;
      }

      const candidates = contents?.filter(
        (content): content is string =>
          typeof content === "string" && records.has(digest(content))
      );
      if (candidates?.length !== 1) return null;

      const original = candidates[0]!;
      const hash = digest(original);
      let allowed = records.get(hash);

      if (allowed === undefined) {
        allowed = !internalHasExplicitJsxRuntimeImport(
          original,
          id.split("?")[0]!
        );
        records.set(hash, allowed);
      }

      return allowed
        ? internalTransformJsxRuntimeGuards(source, id.split("?")[0]!)
        : null;
    }
  };

  return { evidence, guard };
}
