import type { CxWrites } from "./cxWrites.js";

type CxTokenIndexes = {
  classWrites: ReadonlyMap<string, number>;
  segments: ReadonlyMap<string, readonly number[]>;
  markerByWrites: ReadonlyMap<string, string>;
};

export type CxTokenBuffer = {
  data: Uint32Array;
  active: boolean;
  lookup: ReturnType<typeof createSpanIndex>;
};

// IDs are already checked by CxWrites. Cap the extra classification tables at
// 1,024 names and the retained scan buffer at 1,024 tokens (24 KiB total typed
// storage at most). Names reference existing artifact strings, not copies.
export function createCxTokenBuffer(
  indexes: CxTokenIndexes
): CxTokenBuffer | null {
  if (indexes.classWrites.size + indexes.segments.size > 1024) return null;

  return {
    data: new Uint32Array(32 * 3),
    active: false,
    lookup: createSpanIndex(indexes)
  };
}

// Each record stores start, end and packed ID. Zero is unknown, 1..4096 is
// writeId + 1, and bit 13 identifies a segment marker. A zero end marks a drop.
// No input strings are retained in the reusable buffer. Nested calls borrow
// the ordinary merge path while this buffer is active.

export function mergeTokenSpans(
  input: string,
  { segments, markerByWrites }: CxTokenIndexes,
  writes: CxWrites,
  buffer: CxTokenBuffer
): string {
  buffer.active = true;

  try {
    let data = buffer.data;
    let count = 0;
    let normalized = true;
    let start = 0;
    const hasSegments = segments.size > 0;
    let hash = 0;

    for (let index = 0; index <= input.length; index += 1) {
      const code = index < input.length ? input.charCodeAt(index) : 32;

      if (
        index < input.length &&
        ((code > 32 && code < 160) || !isWhitespace(code))
      ) {
        hash = Math.imul(hash ^ code, 0x01000193);
        continue;
      }

      if (index > start) {
        if (count + 3 > data.length) {
          const next = new Uint32Array(data.length * 2);
          next.set(data);
          data = next;

          if (data.length <= 1024 * 3) buffer.data = data;
        }

        data[count++] = start;
        data[count++] = index;
        data[count++] = findSpanCode(input, start, index, hash, buffer.lookup);
      } else normalized = false;

      if (index < input.length && code !== 32) normalized = false;

      start = index + 1;
      hash = 0;
    }

    if (hasSegments) {
      for (let index = 0; index < count; index += 3) {
        if ((data[index + 2] & 8192) === 0) continue;

        const segment = segments.get(
          input.slice(data[index], data[index + 1])
        )!;

        let valid = index + segment.length * 3 + 3 <= count;

        if (valid) {
          for (let offset = 0; offset < segment.length; offset += 1) {
            const raw = data[index + (offset + 1) * 3 + 2] & 8191;

            if ((raw === 0 ? undefined : raw - 1) !== segment[offset]) {
              valid = false;
              break;
            }
          }
        }

        if (!valid) {
          data[index + 2] = 0;
          continue;
        }

        normalized = false;
        data[index + 1] = 0;

        for (let offset = 0; offset < segment.length; offset += 1) {
          const target = index + (offset + 1) * 3;

          if (segment[offset] !== undefined)
            data[target + 2] = segment[offset] + 1;
          else {
            data[target + 2] = 0;
            data[target + 1] = 0;
          }
        }

        index += segment.length * 3;
      }
    }

    const epoch = writes.next();
    const marks = writes.marks;
    let canMark = markerByWrites.size > 0;
    let keptWrites = "";

    for (let index = count - 3; index >= 0; index -= 3) {
      if (data[index + 1] === 0) continue;

      const raw = data[index + 2];

      if (raw === 0) {
        canMark = false;
      } else {
        const id = raw - 1;

        if (marks[id] === epoch) {
          data[index + 1] = 0;
          normalized = false;
          continue;
        }

        marks[id] = epoch;

        if (canMark)
          keptWrites =
            keptWrites.length === 0 ? String(id) : `${id},${keptWrites}`;
      }
    }

    const marker = canMark ? markerByWrites.get(keptWrites) : undefined;
    if (normalized && marker === undefined) return input;

    const parts: string[] = [];
    let runStart = -1;
    let runEnd = 0;

    for (let index = 0; index < count; index += 3) {
      if (data[index + 1] === 0) continue;

      if (
        runStart >= 0 &&
        data[index] === runEnd + 1 &&
        input.charCodeAt(runEnd) === 32
      ) {
        runEnd = data[index + 1];
      } else {
        if (runStart >= 0) parts.push(input.slice(runStart, runEnd));

        runStart = data[index];
        runEnd = data[index + 1];
      }
    }

    if (runStart >= 0) parts.push(input.slice(runStart, runEnd));

    const result = parts.join(" ");

    return marker === undefined ? result : `${marker} ${result}`;
  } finally {
    buffer.active = false;
  }
}

function createSpanIndex({ classWrites, segments }: CxTokenIndexes) {
  const names = [...classWrites.keys()];

  for (const name of segments.keys()) {
    if (!classWrites.has(name)) names.push(name);
  }

  let capacity = 4;

  while (capacity < names.length * 2) capacity *= 2;

  const table = new Uint32Array(capacity);
  const codes = new Uint32Array(names.length);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    let hash = 0;

    for (let offset = 0; offset < name.length; offset += 1)
      hash = Math.imul(hash ^ name.charCodeAt(offset), 0x01000193);

    let slot = hash & (capacity - 1);

    while (table[slot] !== 0) slot = (slot + 1) & (capacity - 1);

    table[slot] = index + 1;

    const id = classWrites.get(name);
    codes[index] =
      (id === undefined ? 0 : id + 1) | (segments.has(name) ? 8192 : 0);
  }

  return { names, table, codes };
}

function findSpanCode(
  input: string,
  start: number,
  end: number,
  hash: number,
  { names, table, codes }: ReturnType<typeof createSpanIndex>
): number {
  let slot = hash & (table.length - 1);

  for (;;) {
    const entry = table[slot];
    if (entry === 0) return 0;

    const name = names[entry - 1];
    if (name.length === end - start && input.startsWith(name, start))
      return codes[entry - 1];

    slot = (slot + 1) & (table.length - 1);
  }
}

export function isWhitespace(code: number): boolean {
  // ECMAScript WhiteSpace + LineTerminator, exactly the old /\s/ contract.
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    (code >= 160 &&
      (code === 160 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff))
  );
}
