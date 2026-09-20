// Frozen merge from the uncommitted implementation before the cn investigation.
// Deliberately independent of the optimized tokenizer, caches, and write tracker.
import { cx, createCx } from "../../classname/cx.js";
import type { DefineRulesCxRuntimeArtifact } from "../cxRuntimeArtifact.js";

export function createReferenceCx(artifact: DefineRulesCxRuntimeArtifact) {
  const classWrites = new Map(artifact.classWrites);
  const segments = new Map(artifact.segments ?? []);
  const markerByWrites = new Map<string, string>();

  for (const [marker, writes] of segments) {
    const sequence = writes.join(",");
    const existing = markerByWrites.get(sequence);

    if (existing === undefined || marker < existing)
      markerByWrites.set(sequence, marker);
  }

  return createCx((...inputs) => {
    const tokens = cx(...inputs)
      .trim()
      .split(/\s+/);

    const classNames: string[] = [];
    const writeIds: (number | undefined)[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.length === 0) continue;

      const segment = segments.get(token);

      if (segment === undefined) {
        classNames.push(token);
        writeIds.push(classWrites.get(token));
        continue;
      }

      let valid = index + segment.length < tokens.length;

      if (valid) {
        for (let offset = 0; offset < segment.length; offset += 1) {
          if (classWrites.get(tokens[index + offset + 1]) !== segment[offset]) {
            valid = false;
            break;
          }
        }
      }

      if (!valid) {
        classNames.push(token);
        writeIds.push(undefined);
        continue;
      }

      for (let offset = 0; offset < segment.length; offset += 1) {
        if (segment[offset] !== undefined) {
          classNames.push(tokens[index + offset + 1]);
          writeIds.push(segment[offset]);
        }
      }

      index += segment.length;
    }

    const seenWrites = new Set<number>();
    const kept: string[] = [];
    const keptWrites: number[] = [];
    let unknown = false;

    for (let index = classNames.length - 1; index >= 0; index -= 1) {
      const id = writeIds[index];

      if (id === undefined) {
        unknown = true;
        kept.push(classNames[index]);
      } else if (!seenWrites.has(id)) {
        seenWrites.add(id);
        kept.push(classNames[index]);
        keptWrites.push(id);
      }
    }

    const result = kept.reverse().join(" ");
    if (unknown) return result;

    const marker = markerByWrites.get(keptWrites.reverse().join(","));

    return marker === undefined ? result : `${marker} ${result}`;
  });
}
