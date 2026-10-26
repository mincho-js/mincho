import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";
import {
  measureBundleBytes,
  bundleSizeMetric,
  type BundleSizeOptions
} from "./bundleSize.js";

export interface ColorThemeContract {
  light: string;
  dark: string;
  targets: readonly string[];
  /** The application guarantees descendants inherit the selected root scheme. */
  inheritance?: "uniform";
  observedVariables?: readonly string[];
}

/** Source: mdn/browser-compat-data css/types/color.json, reviewed 2026-09-25.
 * Pinned minimum versions for CSS light-dark(), not a moving browserslist query. */
export function supportsLightDark(targets: readonly string[]): boolean {
  const minimum: Record<string, number> = {
    chrome: 123,
    edge: 123,
    firefox: 120,
    safari: 17.5,
    ios: 17.5
  };
  return (
    targets.length > 0 &&
    targets.every((target) => {
      const match = /^(chrome|edge|firefox|safari|ios)(\d+(?:\.\d+)?)$/.exec(
        target
      );
      return !!match && Number(match[2]) >= minimum[match[1]!]!;
    })
  );
}

export function compactColorThemes(
  input: readonly (VanillaCssArtifact | undefined)[],
  contract: ColorThemeContract | undefined,
  options?: BundleSizeOptions
) {
  const metric = bundleSizeMetric(options);
  const skip = (reason: string) => ({ artifacts: input, applied: 0, reason });
  if (!contract) return skip("missing-color-contract");
  if (contract.inheritance !== "uniform")
    return skip("missing-uniform-inheritance");
  if (!supportsLightDark(contract.targets))
    return skip("unsupported-css-targets");
  const output = input.map((item) => item && structuredClone(item));
  const color = (value: unknown) =>
    typeof value === "string" &&
    (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ||
      /^(?:rgb|hsl|oklch|oklab|lab|lch)a?\([\d\s.,%+/-]+\)$/i.test(value) ||
      /^(?:transparent|black|white|red|blue|green)$/.test(value));
  for (const artifact of output) {
    if (!artifact || artifact.provenance?.opaque) continue;
    const roots = artifact.cssObjs;
    for (let index = 1; index < roots.length; index++) {
      const a = roots[index - 1],
        b = roots[index];
      if (
        a?.type !== "local" ||
        b?.type !== "local" ||
        ![a.selector, b.selector].includes(contract.light) ||
        ![a.selector, b.selector].includes(contract.dark) ||
        a.selector === b.selector
      )
        continue;
      const light = a.selector === contract.light ? a : b;
      const dark = a.selector === contract.dark ? a : b;
      if (
        light.rule.colorScheme !== "light" ||
        dark.rule.colorScheme !== "dark" ||
        Object.keys(light.rule).some(
          (key) => key !== "vars" && key !== "colorScheme"
        ) ||
        Object.keys(dark.rule).some(
          (key) => key !== "vars" && key !== "colorScheme"
        )
      )
        continue;
      const first = light.rule.vars,
        second = dark.rule.vars;
      if (
        !first ||
        !second ||
        Object.keys(first).length !== Object.keys(second).length ||
        !Object.keys(first).every((key) => {
          const name = /^var\((--[^)]+)\)$/.exec(key)?.[1] ?? key;
          return (
            Object.hasOwn(second, key) &&
            color(first[key]) &&
            color(second[key]) &&
            !contract.observedVariables?.includes(name)
          );
        })
      )
        continue;
      light.rule = { colorScheme: "light" };
      dark.rule = { colorScheme: "dark" };
      roots.splice(index + 1, 0, {
        type: "global",
        selector: `${contract.light}, ${contract.dark}`,
        rule: {
          vars: Object.fromEntries(
            Object.keys(first).map((name) => [
              name,
              first[name] === second[name]
                ? first[name]
                : `light-dark(${first[name]}, ${second[name]})`
            ])
          )
        }
      });
      const bytes = (values: typeof input) =>
        measureBundleBytes(
          values
            .map((value) => (value ? generateVanillaCss(value) : ""))
            .join("\n")
        )[metric];
      if (bytes(output) < bytes(input))
        return {
          artifacts: output,
          applied: 1,
          reason: "supported-color-only-win"
        };
      return { artifacts: input, applied: 0, reason: "no-size-win" };
    }
  }
  return {
    artifacts: input,
    applied: 0,
    reason: "no-adjacent-color-only-pair"
  };
}
