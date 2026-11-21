import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { serializeVanillaModule } from "@vanilla-extract/integration";
import { analyzeExtractCalls } from "../extractionCalls/analysis.js";
import type { ModuleGraphResponse } from "../moduleGraph.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore This test helper runs as ESM; ignore import.meta for CJS declarations.
const fixtureRequire = createRequire(import.meta.url);

/** Model the host's real serialization boundary, not a hand-issued receipt. */
export function prepareSerializedRecipeProvider(
  source: string,
  exports: Record<string, unknown>
) {
  const serialized = serializeVanillaModule([], exports, null);
  const themeId = "/fixture/theme.css.ts";
  const flow = analyzeExtractCalls({
    source,
    filename: "/fixture/entry.tsx",
    root: "/fixture",
    jsx: true,
    extractCalls: { "custom-preset": ["css"] }
  });
  let step = flow.next();
  while (!step.done) {
    const request = step.value;
    let response: ModuleGraphResponse = null;
    if (request.kind === "resolve") {
      if (request.source === "./theme.css.js") response = themeId;
      else {
        try {
          response = fixtureRequire.resolve(request.source);
        } catch {
          /* Unavailable source stays unproved. */
        }
      }
    } else if (request.kind === "load") {
      if (request.id === themeId) {
        if (request.purpose === "consumer-runtime")
          response = {
            source: serialized,
            sourceHash: createHash("sha256").update(serialized).digest("hex"),
            version: "actual-vanilla-serializer:1",
            watchFiles: []
          };
      } else {
        try {
          response = readFileSync(request.id, "utf8");
        } catch {
          /* The compiler retains its unresolved-source fallback. */
        }
      }
    }
    step = flow.next(response);
  }
  return step.value;
}
