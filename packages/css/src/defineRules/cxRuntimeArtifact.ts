import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";
import { createCanonicalWriteKey } from "./metadata.js";
import type { CompiledSegment } from "./metadata.js";
import type { DefineRulesPresetArtifactV5 } from "./types.js";

export type DefineRulesCxRuntimeArtifact = {
  readonly classWrites: readonly (readonly [string, number])[];
  readonly segments?: readonly (readonly [string, readonly number[]])[];
};

export function createDefineRulesCxRuntimeArtifact(
  preset: DefineRulesPresetArtifactV5,
  segmentsByMarker: ReadonlyMap<string, CompiledSegment>
): DefineRulesCxRuntimeArtifact {
  const graph = resolveDefineRulesPresetGraphV5([preset]);
  const classWrites: Array<readonly [string, number]> = [];
  const writeIdByClassName = new Map<string, number>();
  const writeIdByKey = new Map<string, number>();

  for (const atom of graph.atomById.values()) {
    const key = createCanonicalWriteKey(atom.condition, atom.property);

    if (!writeIdByKey.has(key)) {
      writeIdByKey.set(key, writeIdByKey.size);
    }
  }

  for (const [className, atomId] of graph.atomIdByClassName) {
    const atom = graph.atomById.get(atomId);

    if (atom === undefined) {
      throw new TypeError(`Missing defineRules atom for ${className}`);
    }

    const key = createCanonicalWriteKey(atom.condition, atom.property);
    const writeId = writeIdByKey.get(key);

    if (writeId === undefined) {
      throw new TypeError(`Missing defineRules write ID for ${className}`);
    }

    classWrites.push([className, writeId]);
    writeIdByClassName.set(className, writeId);
  }

  const segments: Array<readonly [string, readonly number[]]> = [];

  for (const [marker, segment] of segmentsByMarker) {
    const writes: number[] = [];

    for (const entry of segment.entries) {
      if (entry.kind !== "known") {
        throw new TypeError(`Invalid defineRules segment marker ${marker}`);
      }

      const writeId = writeIdByClassName.get(entry.className);

      if (writeId === undefined) {
        throw new TypeError(
          `Unknown defineRules segment class ${entry.className}`
        );
      }

      writes.push(writeId);
    }

    segments.push([marker, writes]);
  }

  return segments.length === 0 ? { classWrites } : { classWrites, segments };
}
