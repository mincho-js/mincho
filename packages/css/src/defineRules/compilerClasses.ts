import type {
  CSSRule,
  NormalizedCondition
} from "@mincho-js/transform-to-vanilla";
import { transform } from "@mincho-js/transform-to-vanilla";
import { appendCss, registerClassName } from "@vanilla-extract/css/adapter";
import { getFileScope } from "@vanilla-extract/css/fileScope";
import type { FileScope, StyleRule } from "@vanilla-extract/css";
import { sha256 } from "./presetSha256.js";

export interface CompilerClassStrategy {
  version: 1;
  globalAtomicClasses: boolean;
  compileClass: boolean;
  sizeAware?: boolean;
  metric?: "raw" | "gzip" | "brotli";

  /** Original module: the conservative cascade and relative URL domain. */
  source: string;
}

type CompilerCss = (input: never) => string;

const compilerMethods = new WeakMap<
  CompilerCss,
  (input: never, strategy: CompilerClassStrategy) => string
>();

export function registerCompilerClassMethod(
  css: CompilerCss,
  method: (input: never, strategy: CompilerClassStrategy) => string
): void {
  compilerMethods.set(css, method);
}

/** @internal Emitted only inside an extracted, compiler-proven private call. */
export function compilePrivateDefineRulesClass(
  css: CompilerCss,
  input: never,
  strategy: CompilerClassStrategy
): string {
  const method = compilerMethods.get(css);

  return strategy.version === 1 && method
    ? method(input, strategy)
    : css(input);
}

// Deliberately excludes shorthands, logical/physical aliases, custom properties,
// and properties whose values create additional rules. Broaden only with proofs.
const independentLonghands = new Set([
  "color",
  "backgroundColor",
  "opacity",
  "display",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "visibility",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "order",
  "columnGap",
  "rowGap",
  "overflowX",
  "overflowY",
  "whiteSpace",
  "boxSizing",
  "cursor",
  "pointerEvents",
  "objectFit",
  "objectPosition"
]);

interface CompilerAtomicWrite {
  property: string;
  value: unknown;
  condition: NormalizedCondition;
}

const conditionalOrder = new WeakMap<
  FileScope,
  { last: Map<string, string>; emitted: Set<string> }
>();

/** Return canonical atom identities, preserving declaration/conflict order. */
export function compilerAtomIdentities(
  writes: readonly CompilerAtomicWrite[],
  strategy: CompilerClassStrategy | undefined
): string[] | undefined {
  if (!strategy || strategy.version !== 1 || !strategy.source || !writes.length)
    return undefined;

  const properties = new Set<string>();
  const identities: string[] = [];
  const scope = getFileScope();
  let order = conditionalOrder.get(scope);

  if (!order)
    conditionalOrder.set(
      scope,
      (order = { last: new Map(), emitted: new Set() })
    );

  for (const { property, value, condition } of writes) {
    if (
      !independentLonghands.has(property) ||
      properties.has(property) ||
      (typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value))) ||
      (typeof value === "string" &&
        (/url\s*\(/i.test(value) || value.includes("\\"))) ||
      !/^&(?::(?:hover|focus|focus-visible|active|disabled))?$/.test(
        condition.selector
      ) ||
      condition.container != null
    ) {
      order.last.clear();

      return undefined;
    }

    properties.add(property);
    identities.push(
      JSON.stringify({
        version: 1,

        // Sharing across files would let a lazy duplicate rule change another
        // file's cascade. Keep that boundary until final ownership is proven.
        cascadeDomain: strategy.source.replace(/\\/g, "/"),
        property,
        value,
        condition: {
          selector: condition.selector,
          supports: condition.supports ?? null,
          media: condition.media ?? null,
          container: null
        },
        layer: condition.layer ?? null,

        // There is one write, and the accepted longhands cannot overlap. The
        // ordinal of an unrelated property must not change this atom's identity
        // or the serialized preset's property/value lookup key.
        conflictOrder: "independent-single-write",
        urlSource: null
      })
    );
  }

  // Equal conditional atoms cannot jump across possibly overlapping writes.
  const blocked = identities.some((identity, index) => {
    const { property, condition } = writes[index]!;
    const conditional =
      condition.selector !== "&" ||
      condition.layer != null ||
      condition.media != null ||
      condition.supports != null;

    return (
      conditional &&
      order.emitted.has(identity) &&
      order.last.get(property) !== identity
    );
  });

  for (let index = 0; index < writes.length; index++) {
    order.last.set(writes[index]!.property, blocked ? "" : identities[index]!);

    if (!blocked) order.emitted.add(identities[index]!);
  }

  return blocked ? undefined : identities;
}

export function compilerClassName(
  kind: "atom" | "combination",
  identity: string
): string {
  // Re-encode the same 128 bits, rather than increasing the collision risk by
  // truncating the digest. This pure encoder also works in isolated evaluators.
  const hex = sha256(identity).slice(0, 32);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  let bits = 0;
  let value = 0;

  for (let index = 0; index < hex.length; index += 2) {
    value = (value << 8) | Number.parseInt(hex.slice(index, index + 2), 16);
    bits += 8;

    while (bits >= 6) {
      bits -= 6;
      encoded += alphabet[(value >>> bits) & 63];
    }
    value &= (1 << bits) - 1;
  }

  if (bits) encoded += alphabet[(value << (6 - bits)) & 63];

  return `m${kind === "atom" ? "a" : "c"}_${encoded}`;
}

const emittedByFile = new WeakMap<FileScope, Set<string>>();

export type CompilerClassCandidate = {
  className: string;
  rules: { className: string; style: CSSRule }[];
};
type ClassCost = (
  candidates: readonly CompilerClassCandidate[],
  metric: "raw" | "gzip" | "brotli"
) => readonly number[];
const costKey = Symbol.for("@mincho-js/compiler-class-cost/v1");
const costState = globalThis as typeof globalThis & { [costKey]?: ClassCost[] };

export function beginCompilerClassCost(cost: ClassCost): void {
  (costState[costKey] ??= []).push(cost);
}
export function endCompilerClassCost(): void {
  costState[costKey]?.pop();
  if (!costState[costKey]?.length) delete costState[costKey];
}

/** Build host owns compression. No Node APIs or decoder enter the CSS runtime. */
export function preferCompilerAtoms(
  candidates: readonly CompilerClassCandidate[],
  metric: "raw" | "gzip" | "brotli" = "brotli"
): boolean {
  const costs = costState[costKey];
  const cost = costs?.[costs.length - 1];
  if (!cost) return false;
  try {
    const emitted = emittedByFile.get(getFileScope());
    const measured = cost(
      candidates.map((candidate) => ({
        ...candidate,
        rules: candidate.rules
          .filter((rule) => !emitted?.has(rule.className))
          .map((rule) => ({ ...rule, style: transform(rule.style) as CSSRule }))
      })),
      metric
    );
    return (
      measured.length === 2 &&
      measured.every(Number.isFinite) &&
      measured[1]! < measured[0]!
    );
  } catch {
    return false;
  }
}

/** Register the selected identity before CSS/exports/preset metadata see it. */
export function emitCompilerClass(className: string, style: CSSRule): string {
  const fileScope = getFileScope();
  registerClassName(className, fileScope);

  let emitted = emittedByFile.get(fileScope);

  if (!emitted) emittedByFile.set(fileScope, (emitted = new Set()));

  if (!emitted.has(className)) {
    emitted.add(className);
    appendCss(
      {
        type: "local",
        selector: className,
        rule: transform(style) as StyleRule
      },
      fileScope
    );
  }

  return className;
}
