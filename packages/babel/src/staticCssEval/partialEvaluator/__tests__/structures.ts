import { types as t } from "@babel/core";
import {
  expectFixtureConfidentExpression,
  expectFixtureDeoptResult,
  expectNumericLiteralExpression,
  expectObjectExpression,
  expectObjectPropertyExpression,
  expectStringLiteralExpression,
  reduceFixture
} from "./helpers.js";

export function registerPartialEvalStructureTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, expect, it } = vitest;

  describe("partial evaluator same-file member object array spread reducer", () => {
    it.each(["01", "00", "1.0"])(
      "does not alias array property %s to an index",
      (key) => {
        const results = reduceFixture(
          `capture([4, 8][${JSON.stringify(key)}]); capture([4, 8]["1"]);`
        );
        expectFixtureDeoptResult(results, 0);
        expectNumericLiteralExpression(
          expectFixtureConfidentExpression(results, 1),
          8
        );
      }
    );

    it.each([
      '({ ["__proto__"]: 4 }).__proto__',
      '({ ["__" + "proto__"]: 4 }).__proto__',
      '({ __proto__: null, ["__proto__"]: 4 }).__proto__',
      '({ ["__proto__"]: 4, __proto__: null }).__proto__',
      '({ ...{ ["__proto__"]: 4 } }).__proto__',
      "({ __proto__: { size: 4 } }).size",
      "({ __proto__: { size: 12 }, size: 4 }).size",
      "({ size: 4, __proto__: { size: 12 } }).size"
    ])(
      "preserves own property and explicit prototype selection: %s",
      (value) => {
        expectNumericLiteralExpression(
          expectFixtureConfidentExpression(
            reduceFixture(`capture(${value});`),
            0
          ),
          4
        );
      }
    );

    it("preserves shorthand own __proto__ when reducing the property value", () => {
      const result = reduceFixture(
        "const __proto__ = 4; capture(({ __proto__ }).__proto__);"
      );
      expectNumericLiteralExpression(
        expectFixtureConfidentExpression(result, 0),
        4
      );
    });

    it.each([
      "({ __proto__: null }).__proto__",
      '({ "__proto__": null }).__proto__',
      "({ ...{ __proto__: { size: 4 } } }).size",
      "({ __proto__: { get size() { return 4; } } }).size"
    ])(
      "does not select a prototype setter or copied inherited property: %s",
      (value) => {
        expectFixtureDeoptResult(reduceFixture(`capture(${value});`), 0);
      }
    );

    it("reduces same-file const object and static nested member paths", () => {
      const results = reduceFixture(`
        const tokens = {
          button: { color: "red", gap: 4 },
          sizes: ["sm", "lg"]
        };

        capture(tokens.button);
        capture(tokens.button.color);
        capture(tokens.sizes[1]);
      `);

      const button = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectStringLiteralExpression(
        expectObjectPropertyExpression(button, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(button, "gap"),
        4
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 1),
        "red"
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 2),
        "lg"
      );
    });

    it("reduces object and array destructuring from static values", () => {
      const results = reduceFixture(`
        const tokens = {
          button: { color: "red", gap: 4 },
          sizes: ["sm", "lg"]
        };
        const {
          button: { color, ["gap"]: gap },
          sizes: [first, second]
        } = tokens;

        capture(color);
        capture(gap);
        capture(first);
        capture(second);
      `);

      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 0),
        "red"
      );
      expectNumericLiteralExpression(
        expectFixtureConfidentExpression(results, 1),
        4
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 2),
        "sm"
      );
      expectStringLiteralExpression(
        expectFixtureConfidentExpression(results, 3),
        "lg"
      );
    });

    it("distinguishes non-const declarations from actual reassignments", () => {
      const results = reduceFixture(`
        const mutated = { color: "red" };
        mutated.color = "blue";
        let mutable = { color: "red" };
        var hoisted = { color: "red" };
        const nestedMutated = { color: "red" };
        nestedMutated.color = "blue";

        capture(mutated);
        capture(mutable);
        capture(hoisted);
        capture({ nested: nestedMutated });
      `);

      const mutated = expectFixtureDeoptResult(results, 0);

      expect(mutated.reason).toBe("mutated-binding");
      expect(mutated.diagnostic.message).toContain("same-file binding");

      for (let index = 1; index < 3; index += 1) {
        const nonConst = expectFixtureDeoptResult(results, index);

        expect(nonConst.reason).toBe("runtime-css-shape");
        expect(nonConst.diagnostic.message).toContain("is not declared const");
      }

      const nestedMutated = expectFixtureDeoptResult(results, 3);

      expect(nestedMutated.diagnostic.detail).toContain(
        'same-file binding "nestedMutated" is mutated'
      );
    });

    it("preserves destructured child deopt fallback and member path", () => {
      const results = reduceFixture(`
        function read(props) {
          const { color } = props;
          capture(color);
        }
      `);

      const deopt = expectFixtureDeoptResult(results, 0);

      expect(t.isIdentifier(deopt.fallbackExpression)).toBe(true);
      expect(deopt.diagnostic.bindingName).toBe("props");
      expect(deopt.diagnostic.memberPath).toEqual(["color"]);
    });

    it("deopts alias cycle and binding depth limit", () => {
      const cycleResults = reduceFixture(`
        const a = b;
        const b = a;

        capture(a);
      `);

      const depthResults = reduceFixture(
        `
          const a = b;
          const b = { color: "red" };

          capture(a);
        `,
        { maxBindingStackDepth: 1 }
      );

      expect(expectFixtureDeoptResult(cycleResults, 0).reason).toBe(
        "cycle-detected"
      );
      expect(expectFixtureDeoptResult(depthResults, 0).reason).toBe(
        "depth-limit"
      );
    });

    it("deopts getter method and dynamic computed member", () => {
      const results = reduceFixture(`
        const methodStyle = { color() { return "red"; } };
        const getterStyle = { get color() { return "red"; } };
        const style = { color: "red" };

        capture(methodStyle);
        capture(getterStyle);
        capture(style[props.key]);
        capture(style?.color);
      `);

      expect(expectFixtureDeoptResult(results, 0).reason).toBe(
        "runtime-css-shape"
      );
      expect(expectFixtureDeoptResult(results, 1).reason).toBe(
        "runtime-css-shape"
      );
      expect(expectFixtureDeoptResult(results, 2).reason).toBe(
        "unsupported-computed-member"
      );
      expect(expectFixtureDeoptResult(results, 3).reason).toBe(
        "runtime-css-shape"
      );
    });

    it("keeps unsupported call expressions as reducer deopt without invoking functions", () => {
      const results = reduceFixture(
        `
        function explode() {
          throw new Error("must not run");
        }

        capture({ color: explode() });
        capture({ ...explode() });
        capture(` +
          "`color-${explode()}`" +
          `);
      `
      );

      expect(expectFixtureDeoptResult(results, 0).reason).toBe(
        "unsupported-call-expression"
      );
      expect(expectFixtureDeoptResult(results, 1).reason).toBe(
        "unsupported-spread"
      );
      expect(expectFixtureDeoptResult(results, 2).reason).toBe(
        "unsupported-call-expression"
      );
    });

    it("short-circuits const-bound primitive left operands", () => {
      const result = expectFixtureConfidentExpression(
        reduceFixture(`
          const disabled = false;
          capture(disabled && explode());
        `),
        0
      );

      expect(t.isBooleanLiteral(result, { value: false })).toBe(true);
    });

    it("deopts imported unknown bindings at the resolver boundary", () => {
      const results = reduceFixture(`
        import { style } from "./style";

        capture(style);
      `);

      const deopt = expectFixtureDeoptResult(results, 0);

      expect(deopt.reason).toBe("unsupported-import");
      expect(deopt.diagnostic.bindingName).toBe("style");
    });
  });
}
