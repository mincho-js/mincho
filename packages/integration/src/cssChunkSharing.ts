import { createHash } from "node:crypto";

/** Experimental whole-module CSS sharing. Disabled unless explicitly enabled. */
export type MinchoCssChunkSharingOptions =
  | boolean
  | { minBoundaries?: number; minBytes?: number };

export interface CssSharingBoundary {
  id: string;

  /** Native CSS evaluation order, including modules that cannot be shared. */
  modules: readonly string[];
}

export interface CssSharingModule {
  bytes: number;
  shareable: boolean;
}

export interface CssSharingGroup {
  name: string;
  modules: readonly string[];
  boundaries: readonly string[];
  savedBytes: number;
}

export function resolveCssChunkSharingOptions(
  options: MinchoCssChunkSharingOptions | undefined
): { minBoundaries: number; minBytes: number } | undefined {
  if (!options) return;

  const { minBoundaries = 2, minBytes = 4096 } =
    typeof options === "object" ? options : {};
  if (!Number.isSafeInteger(minBoundaries) || minBoundaries < 2)
    throw new Error("cssChunkSharing.minBoundaries must be an integer >= 2.");
  if (!Number.isSafeInteger(minBytes) || minBytes < 0)
    throw new Error("cssChunkSharing.minBytes must be an integer >= 0.");

  return { minBoundaries, minBytes };
}

/**
 * Sharing only identical prefixes preserves cascade order. A module is moved
 * only when every consumer agrees on that prefix, including dynamic boundaries.
 */
export function planCssChunkSharing(
  boundaries: readonly CssSharingBoundary[],
  modules: ReadonlyMap<string, CssSharingModule>,
  options: { minBoundaries: number; minBytes: number },
  nameKey: (id: string) => string = (id) => id
): CssSharingGroup[] {
  interface Prefix {
    id: string;
    parent?: Prefix;
    children: Map<string, Prefix>;
    boundaries: string[];
    bytes: number;
  }

  const root: Prefix = {
    id: "",
    children: new Map(),
    boundaries: [],
    bytes: 0
  };

  const prefixes: Prefix[] = [];
  const consumers = new Map<string, Set<string>>();

  for (const boundary of boundaries) {
    for (const id of boundary.modules) {
      const ids = consumers.get(id) ?? new Set<string>();
      ids.add(boundary.id);
      consumers.set(id, ids);
    }

    let prefix = root;

    for (const id of boundary.modules) {
      const module = modules.get(id);
      if (!module?.shareable) break;

      let candidate = prefix.children.get(id);

      if (!candidate) {
        candidate = {
          id,
          parent: prefix,
          children: new Map(),
          boundaries: [],
          bytes: prefix.bytes + module.bytes
        };
        prefix.children.set(id, candidate);
        prefixes.push(candidate);
      }

      candidate.boundaries.push(boundary.id);
      prefix = candidate;
    }
  }

  const candidates: CssSharingGroup[] = [];
  const largestConsumerCount = new Map<Prefix, number>();

  for (const prefix of prefixes)
    largestConsumerCount.set(
      prefix,
      Math.max(
        largestConsumerCount.get(prefix.parent!) ?? 0,
        consumers.get(prefix.id)!.size
      )
    );

  for (const prefix of prefixes) {
    if (
      prefix.boundaries.length < options.minBoundaries ||
      prefix.bytes < options.minBytes ||
      largestConsumerCount.get(prefix) !== prefix.boundaries.length ||
      [...prefix.children.values()].some(
        (child) =>
          child.boundaries.length === prefix.boundaries.length &&
          largestConsumerCount.get(child) === child.boundaries.length
      )
    )
      continue;

    const members = new Set(prefix.boundaries);
    const ids: string[] = [];

    for (let current = prefix; current.parent; current = current.parent)
      ids.push(current.id);

    ids.reverse();

    if (
      ids.some((id) =>
        [...consumers.get(id)!].some((consumer) => !members.has(consumer))
      )
    )
      continue;

    candidates.push({
      name: `mincho-shared-${createHash("sha256")
        .update(JSON.stringify(ids.map(nameKey)))
        .digest("hex")
        .slice(0, 12)}`,
      modules: ids,
      boundaries: [...prefix.boundaries].sort(),
      savedBytes: prefix.bytes * (prefix.boundaries.length - 1)
    });
  }

  candidates.sort(
    (a, b) => b.savedBytes - a.savedBytes || a.name.localeCompare(b.name)
  );

  const assigned = new Set<string>();

  return candidates.filter((candidate) => {
    if (candidate.boundaries.some((id) => assigned.has(id))) return false;

    candidate.boundaries.forEach((id) => assigned.add(id));

    return true;
  });
}

const isCssWhitespace = (character: string | undefined) =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\f" ||
  character === "\r";

function trimCssWhitespace(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && isCssWhitespace(value[start])) start++;
  while (end > start && isCssWhitespace(value[end - 1])) end--;

  return value.slice(start, end);
}

/** Conservative CSS classifier; unknown syntax stays in its native chunk. */
export function isShareableCss(source: string): boolean {
  // Comments and quoted values cannot introduce selectors or block delimiters.
  // Scan each span once, including malformed input with many opening tokens.
  const parts: string[] = [];
  let unmaskedStart = 0;

  for (let index = 0; index < source.length; ) {
    const start = index;
    const character = source[index];

    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return false;

      index = end + 2;
    } else if (character === '"' || character === "'") {
      index++;

      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") {
          index +=
            source[index + 1] === "\r" && source[index + 2] === "\n" ? 3 : 2;
        } else {
          if ("\n\r\f".includes(source[index]!)) return false;

          index++;
        }
      }

      if (index >= source.length) return false;

      index++;
    } else {
      index++;

      continue;
    }

    parts.push(source.slice(unmaskedStart, start), " ".repeat(index - start));
    unmaskedStart = index;
  }

  parts.push(source.slice(unmaskedStart));

  const masked = parts.join("");

  let position = 0;
  let rules = 0;

  const block = (nested: boolean): boolean => {
    while (position < masked.length) {
      while (position < masked.length && isCssWhitespace(masked[position]))
        position++;

      if (position === masked.length) return !nested;

      if (masked[position] === "}") {
        position++;

        return nested;
      }

      const start = position;

      while (position < masked.length && !"{};".includes(masked[position]!))
        position++;

      if (masked[position] !== "{") return false;

      const header = trimCssWhitespace(masked.slice(start, position));
      position++;

      const atRule = /^@(media|supports|container)/i.exec(header);

      if (atRule && isCssWhitespace(header[atRule[0].length])) {
        if (!block(true)) return false;

        continue;
      }

      // Restrict selectors to one class compound. Descendants, global selectors,
      // CSS nesting and escaped syntax need a richer ownership proof.
      if (
        !header
          .split(",")
          .every((selector) =>
            /^\.[_a-zA-Z][\w-]*(?:\.[_a-zA-Z][\w-]*|:[\w-]+)*$/.test(
              trimCssWhitespace(selector)
            )
          )
      )
        return false;

      rules++;

      while (position < masked.length && masked[position] !== "}") {
        if (masked[position] === "{" || masked[position] === "@") return false;

        position++;
      }

      if (masked[position] !== "}") return false;

      position++;
    }

    return !nested;
  };

  return block(false) && position === masked.length && rules > 0;
}
