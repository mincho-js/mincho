import { cx } from "../classname/cx.js";
import type {
  ClassMultipleInput,
  ClassMultipleResult,
  ClassValue,
  CxWith,
  CxWithCallback,
  CxWithCallbackArgs,
  CxWithMixin,
  CxWithTupleValue
} from "../classname/types.js";
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
  const markerByWrites = new Map<string, string>();

  for (const [marker, writes] of Object.entries(artifact.segments ?? {})) {
    markerByWrites.set(writes.join(","), marker);
  }

  const cxImpl = (...inputs: ClassValue[]) => {
    const entries = collectEntries(cx(...inputs), artifact);
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

  function cxMultiple<T extends ClassMultipleInput>(
    map: T
  ): ClassMultipleResult<T> {
    const result = {} as ClassMultipleResult<T>;

    for (const key in map) {
      result[key] = cxImpl(map[key]);
    }

    return result;
  }

  function cxWith<const T extends ClassValue>(): CxWith<T>;
  function cxWith<const F extends CxWithCallback>(
    callback: F
  ): CxWithMixin<CxWithCallbackArgs<F>>;
  function cxWith<const Input>(
    callback: (params: Input) => ClassValue
  ): CxWithMixin<[params: Input]>;
  function cxWith<const T extends ClassValue, const F extends CxWithCallback>(
    callback?: ((params: T) => ClassValue) | F
  ): CxWith<T> & CxWithMixin<CxWithCallbackArgs<F>> {
    type CxWithRuntimeCallback = (...className: unknown[]) => ClassValue;
    const cxFunction = (callback ??
      ((...className: ClassValue[]) => className)) as CxWithRuntimeCallback;

    function cxWithImpl(...className: unknown[]) {
      return cxImpl(cxFunction(...className));
    }

    function cxWithMultiple<
      ClassNameMap extends Record<
        string,
        T | CxWithTupleValue<CxWithCallbackArgs<F>>
      >
    >(classNameMap: ClassNameMap): ClassMultipleResult<ClassNameMap> {
      type TransformedClassNameMap = Record<keyof ClassNameMap, ClassValue>;
      const transformedClassNameMap: TransformedClassNameMap =
        {} as TransformedClassNameMap;

      for (const key in classNameMap) {
        const value = classNameMap[key];
        transformedClassNameMap[key] = Array.isArray(value)
          ? cxFunction(...value)
          : cxFunction(value);
      }

      return cxMultiple(transformedClassNameMap);
    }

    return Object.assign(cxWithImpl, {
      multiple: cxWithMultiple
    }) as CxWith<T> & CxWithMixin<CxWithCallbackArgs<F>>;
  }

  return Object.assign(cxImpl, {
    multiple: cxMultiple,
    with: cxWith
  }) as Cx;
};

function collectEntries(
  className: string,
  artifact: DefineRulesCxRuntimeArtifact
): RuntimeEntry[] {
  const entries: RuntimeEntry[] = [];
  const tokens = className.trim().split(/\s+/);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) {
      continue;
    }

    const segments = artifact.segments;
    const hasSegment =
      segments !== undefined &&
      Object.prototype.hasOwnProperty.call(segments, token);
    const segment = hasSegment ? segments[token] : undefined;

    if (segment === undefined) {
      appendClassEntry(entries, token, artifact.classWrites);
      continue;
    }

    const payload = tokens.slice(index + 1, index + segment.length + 1);

    if (
      payload.length !== segment.length ||
      !payload.every(
        (value, payloadIndex) =>
          Object.prototype.hasOwnProperty.call(artifact.classWrites, value) &&
          artifact.classWrites[value] === segment[payloadIndex]
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
  classWrites: Record<string, number>
): void {
  const writeId = Object.prototype.hasOwnProperty.call(classWrites, className)
    ? classWrites[className]
    : undefined;

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

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  describe("defineRules cx runtime", () => {
    it("preserves prototype-inherited tokens as unknown", () => {
      const runtimeWithSegments = createDefineRulesCxRuntime({
        classWrites: {},
        segments: {}
      });
      const runtimeWithoutSegments = createDefineRulesCxRuntime({
        classWrites: {}
      });

      expect(runtimeWithSegments("toString toString")).toBe(
        "toString toString"
      );
      expect(runtimeWithoutSegments("__proto__ __proto__")).toBe(
        "__proto__ __proto__"
      );
    });

    it("preserves inherited marker payload write IDs as unknown", () => {
      const classWrites: Record<string, number> = { owned: 1 };
      Object.setPrototypeOf(classWrites, { inherited: 1 });
      const runtime = createDefineRulesCxRuntime({
        classWrites,
        segments: { marker: [1] }
      });

      expect(runtime("marker inherited owned")).toBe("marker inherited owned");
    });
  });
}
