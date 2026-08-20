import { cx as rootCx, createCx } from "../classname/cx.js";
import type { ClassValue } from "../classname/types.js";
import type { Cx } from "../classname/index.js";
import type { DefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";

type RuntimeEntry =
  | {
      readonly kind: "known";
      readonly className: string;
      readonly writeId: number;
    }
  | { readonly kind: "unknown"; readonly className: string };

export const createDefineRulesCxRuntime = (
  artifact: DefineRulesCxRuntimeArtifact
): Cx => {
  const classWrites = new Map(artifact.classWrites);
  const segments = new Map(artifact.segments ?? []);
  const markerByWrites = new Map<string, string>();

  for (const [marker, writes] of segments) {
    const writeSequence = writes.join(",");
    const existingMarker = markerByWrites.get(writeSequence);

    if (existingMarker === undefined || marker < existingMarker) {
      markerByWrites.set(writeSequence, marker);
    }
  }

  const cxImpl = (...inputs: ClassValue[]) => {
    const entries = collectEntries(rootCx(...inputs), classWrites, segments);
    const seenWrites = new Set<number>();
    const kept: RuntimeEntry[] = [];

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry === undefined) {
        continue;
      }

      if (entry.kind === "unknown") {
        kept.push(entry);
        continue;
      }

      if (!seenWrites.has(entry.writeId)) {
        seenWrites.add(entry.writeId);
        kept.push(entry);
      }
    }

    const merged = kept.reverse();
    const className = merged.map((entry) => entry.className).join(" ");

    if (merged.some((entry) => entry.kind === "unknown")) {
      return className;
    }

    const marker = markerByWrites.get(getKnownWriteIds(merged).join(","));
    return marker === undefined ? className : `${marker} ${className}`;
  };

  return createCx(cxImpl) as Cx;
};

function collectEntries(
  className: string,
  classWrites: ReadonlyMap<string, number>,
  segments: ReadonlyMap<string, readonly number[]>
): RuntimeEntry[] {
  const entries: RuntimeEntry[] = [];
  const tokens = className.trim().split(/\s+/);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) {
      continue;
    }

    const segment = segments.get(token);

    if (segment === undefined) {
      appendClassEntry(entries, token, classWrites);
      continue;
    }

    const payload = tokens.slice(index + 1, index + segment.length + 1);

    if (
      payload.length !== segment.length ||
      !payload.every(
        (value, payloadIndex) =>
          classWrites.get(value) === segment[payloadIndex]
      )
    ) {
      entries.push({ kind: "unknown", className: token });
      continue;
    }

    for (const [payloadIndex, value] of payload.entries()) {
      const writeId = segment[payloadIndex];

      if (writeId !== undefined) {
        entries.push({ kind: "known", className: value, writeId });
      }
    }
    index += segment.length;
  }

  return entries;
}

function appendClassEntry(
  entries: RuntimeEntry[],
  className: string,
  classWrites: ReadonlyMap<string, number>
): void {
  const writeId = classWrites.get(className);

  if (writeId === undefined) {
    entries.push({ kind: "unknown", className });
    return;
  }

  entries.push({ kind: "known", className, writeId });
}

function getKnownWriteIds(entries: readonly RuntimeEntry[]): number[] {
  const writeIds: number[] = [];

  for (const entry of entries) {
    if (entry.kind === "known") {
      writeIds.push(entry.writeId);
    }
  }

  return writeIds;
}
