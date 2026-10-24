import { transformSync, type NodePath, types as t } from "@babel/core";
import { afterEach, describe, it, expect, vi } from "vitest";
import * as bundleSize from "../bundleSize.js";
import { compactRecipes } from "./compactRecipes.js";

afterEach(() => vi.restoreAllMocks());

const config = {
  defaultClassName: "base",
  variantClassNames: { size: { small: "small", large: "large" } },
  defaultVariants: { size: "small" },
  compoundVariants: []
};
const source = (value: unknown) =>
  `import {createCompiledClassRuntimeFn as factory} from '@mincho-js/css/rules/createClassRuntimeFn'; export const recipe = factory(${JSON.stringify(value)});`;
const transform = (
  source: string,
  options: Parameters<typeof compactRecipes>[1]
) =>
  transformSync(source, {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          Program(path: NodePath<t.Program>) {
            compactRecipes(path, options);
          }
        }
      })
    ]
  })!.code!;

describe("compact compiler recipes", () => {
  it.each(["raw", "gzip", "brotli"] as const)(
    "measures only %s when comparing compact metadata",
    (metric) => {
      const selected = vi.spyOn(bundleSize, "measureBundleMetric");
      const all = vi.spyOn(bundleSize, "measureBundleBytes");
      vi.spyOn(bundleSize, "runtimeHelperOverhead").mockReturnValue(0);

      transform(source(config), {
        compactMetadata: true,
        bundleSize: { metric }
      });

      expect(selected.mock.calls.map(([, metric]) => metric)).toEqual([
        metric,
        metric
      ]);
      expect(all).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 0, 1])(
    "measures each helper pair once per transformation, including %j results",
    (overhead) => {
      const measure = vi
        .spyOn(bundleSize, "runtimeHelperOverhead")
        .mockReturnValue(overhead);
      const input = `
        import {createCompiledClassRuntimeFn as classes} from '@mincho-js/css/rules/createClassRuntimeFn';
        import {createCompiledRuntimeFn as full} from '@mincho-js/css/rules/createRuntimeFn';
        ${Array.from(
          { length: 3 },
          (_, index) => `
            export const classRecipe${index} = classes(${JSON.stringify(config)});
            export const fullRecipe${index} = full(${JSON.stringify(config)});
          `
        ).join("\n")}
      `;
      const options = {
        compactMetadata: true,
        bundleSize: { metric: "raw" as const }
      };

      transform(input, options);
      expect(measure.mock.calls).toEqual([
        [
          "@mincho-js/css/rules/createClassRuntimeFn",
          "@mincho-js/css/rules/createPackedRuntimeFn",
          "raw"
        ],
        [
          "@mincho-js/css/rules/createRuntimeFn",
          "@mincho-js/css/rules/createPackedRuntimeFn",
          "raw"
        ]
      ]);

      // A rebuild or an initially missing helper must be observed by the next transform.
      measure.mockReturnValue(2);
      transform(input, options);
      expect(measure).toHaveBeenCalledTimes(4);
      expect(
        measure.mock.results.slice(2).map((result) => result.value)
      ).toEqual([2, 2]);
    }
  );

  it("uses a cache-free helper only below the existing cache threshold", () => {
    const output = transform(source(config), { compactRuntime: true });
    expect(output).toContain("createCompactClassRuntimeFn");
    expect(output).not.toContain('createClassRuntimeFn"');
    expect(output).toContain("#__PURE__");
    const large = {
      ...config,
      compoundVariants: Array.from({ length: 16 }, () => [
        { size: "large" },
        "compound"
      ])
    };
    expect(transform(source(large), { compactRuntime: true })).not.toContain(
      "createCompactClassRuntimeFn"
    );
  });
  it("leaves mutable APIs and observed prototype/dynamic scopes alone", () => {
    expect(transform(source(config), {})).not.toContain(
      "createCompactClassRuntimeFn"
    );
    expect(
      transform(
        source(config).replaceAll(
          "createCompiledClassRuntimeFn",
          "createClassRuntimeFn"
        ),
        { compactRuntime: true }
      )
    ).not.toContain("createCompactClassRuntimeFn");
    expect(
      transform(source(config) + ';eval("recipe")', { compactRuntime: true })
    ).not.toContain("createCompactClassRuntimeFn");
    expect(
      transform(
        source(config).replace(
          '"defaultClassName":"base"',
          '"defaultClassName":getBase()'
        ),
        { compactRuntime: true }
      )
    ).not.toContain("createCompactClassRuntimeFn");
  });
  it("charges decoder overhead, preserving small literals and packing repeated large metadata", () => {
    expect(transform(source(config), { compactMetadata: true })).not.toContain(
      "createPacked"
    );
    const repeated = "long-compiler-class-".repeat(100);
    const large = {
      ...config,
      variantClassNames: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `variant${i}`,
          { small: repeated, large: repeated }
        ])
      )
    };
    expect(
      transform(source(large), {
        compactRuntime: true,
        compactMetadata: true,
        bundleSize: { metric: "raw" }
      })
    ).toContain("createPackedCompactClassRuntimeFn");
  });
});
