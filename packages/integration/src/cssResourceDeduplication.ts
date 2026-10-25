import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";
import {
  measureBundleBytes,
  bundleSizeMetric,
  type BundleSizeOptions
} from "./bundleSize.js";

/** Commas inside quoted family names are not list separators. */
function rewriteFontFamilies(
  value: string,
  aliases: ReadonlyMap<string, string>
) {
  const families: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index <= value.length; index++) {
    const char = value[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "," && index !== value.length) continue;
    const family = value.slice(start, index);
    const match =
      /^([ \t\n\f\r]*)(["']?)([A-Za-z_][\w-]*)\2([ \t\n\f\r]*)$/.exec(family);
    const target = match && aliases.get(match[3]!);
    families.push(
      target
        ? `${match![1]}${match![2]}${target}${match![2]}${match![4]}`
        : family
    );
    start = index + 1;
  }
  return quote || start <= value.length ? value : families.join(",");
}

/** CSS-contained names only. A reference in another chunk pins its original definition. */
export function dedupeCssResources(
  input: readonly (VanillaCssArtifact | undefined)[],
  outside: ReadonlySet<string>,
  options?: BundleSizeOptions
) {
  const artifacts = input.map((item) => item && structuredClone(item));
  const diagnostics = { candidates: 0, applied: 0, bailout: 0 };
  if (
    input.some(
      (item) =>
        !item ||
        !item.provenance ||
        item.provenance.opaque ||
        item.provenance.resources?.version !== 2
    )
  )
    return { artifacts: input, diagnostics };
  const privateNames = new Set<string>();
  const pinned = new Set(outside);
  for (const item of input) {
    const resources = item!.provenance!.resources!;
    for (const name of [...resources.keyframes, ...(resources.fonts ?? [])])
      privateNames.add(name.replace(/^"|"$/g, ""));
    for (const name of [
      ...resources.publicKeyframes,
      ...(resources.publicFonts ?? resources.fonts ?? [])
    ])
      pinned.add(name.replace(/^"|"$/g, ""));
  }
  const definitions = new Map<string, number>();
  const definition = (
    root: NonNullable<(typeof artifacts)[number]>["cssObjs"][number]
  ) =>
    root.type === "keyframes"
      ? root.name
      : root.type === "fontFace" && typeof root.rule.fontFamily === "string"
        ? root.rule.fontFamily.replace(/^"|"$/g, "")
        : undefined;
  for (const item of artifacts)
    for (const root of item!.cssObjs) {
      const name = definition(root);
      if (name) definitions.set(name, (definitions.get(name) ?? 0) + 1);
    }
  const scan = (value: unknown, property = "") => {
    if (typeof value === "string") {
      // Unknown indirection or escape grammar can hide a reference.
      if (/\\|(?:var|env)\(/.test(value))
        for (const name of privateNames) pinned.add(name);
      if (!/^(?:animation(?:Name)?|fontFamily|name)$/.test(property))
        for (const [name] of value.matchAll(/[\w-]+/g))
          if (privateNames.has(name)) pinned.add(name);
    } else if (Array.isArray(value))
      for (const child of value) scan(child, property);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) scan(child, key);
  };
  for (const item of artifacts) scan(item!.cssObjs);
  const canonical = new Map<string, string>();
  const aliases = new Map<string, string>();
  const fontAliases = new Map<string, string>();
  const keyframeAliases = new Map<string, string>();
  for (const item of artifacts)
    for (const root of item!.cssObjs) {
      const name = definition(root);
      if (
        !name ||
        !privateNames.has(name) ||
        pinned.has(name) ||
        definitions.get(name) !== 1 ||
        !/^[A-Za-z_][\w-]*$/.test(name)
      )
        continue;
      const body = "rule" in root ? { ...root.rule } : {};
      if (root.type === "fontFace")
        delete (body as Record<string, unknown>).fontFamily;
      const signature = root.type + JSON.stringify(body);
      if (/url\s*\(\s*["']?(?!data:|https?:|\/)/i.test(signature)) continue;
      const previous = canonical.get(signature);
      if (previous) {
        aliases.set(name, previous);
        (root.type === "fontFace" ? fontAliases : keyframeAliases).set(
          name,
          previous
        );
        diagnostics.candidates++;
      } else canonical.set(signature, name);
    }
  if (!aliases.size) return { artifacts: input, diagnostics };
  const rewrite = (value: unknown, property = ""): unknown => {
    if (typeof value === "string") {
      if (property === "fontFamily")
        return rewriteFontFamilies(value, fontAliases);
      for (const [name, target] of keyframeAliases)
        value = (value as string).replace(
          new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "g"),
          target
        );
      return value;
    }
    if (Array.isArray(value))
      return value.map((item) => rewrite(item, property));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, rewrite(child, key)])
      );
    return value;
  };
  for (const item of artifacts)
    item!.cssObjs = item!.cssObjs
      .filter((root) => !aliases.has(definition(root) ?? ""))
      .map((root) => rewrite(root) as typeof root);
  const metric = bundleSizeMetric(options);
  const bytes = (items: typeof input) =>
    measureBundleBytes(
      items.map((item) => (item ? generateVanillaCss(item) : "")).join("\n")
    )[metric];
  if (bytes(artifacts) >= bytes(input))
    return {
      artifacts: input,
      diagnostics: { ...diagnostics, bailout: aliases.size }
    };
  return { artifacts, diagnostics: { ...diagnostics, applied: aliases.size } };
}
