import { types as t } from "@babel/core";
import {
  expectArrayElementExpression,
  expectArrayExpression,
  expectFixtureConfidentExpression,
  expectFixtureDeoptResult,
  expectNoSpreadElement,
  expectNumericLiteralExpression,
  expectObjectExpression,
  expectObjectPropertyExpression,
  expectStringLiteralExpression,
  getStaticObjectPropertyName,
  reduceFixture
} from "./helpers.js";

export function registerPartialEvalSpreadKeyPrimitiveTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, expect, it } = vitest;

  function expectObjectPropertyNames(
    expression: t.ObjectExpression,
    names: readonly string[]
  ): void {
    expect(
      expression.properties.map((property) =>
        t.isObjectProperty(property)
          ? getStaticObjectPropertyName(property.key)
          : null
      )
    ).toEqual(names);
  }

  function expectStaticObjectProperty(
    expression: t.ObjectExpression,
    propertyName: string
  ): t.ObjectProperty {
    const property = expectObjectProperty(expression, propertyName);
    expect(property.computed).toBe(false);
    expect(property.shorthand).toBe(false);
    return property;
  }

  describe("partial evaluator spread and key primitives", () => {
    it("flattens static array spread operands", () => {
      const results = reduceFixture(`
        const prefix = ["base", ...["middle"]];
        const suffix = ["last"];

        capture([...prefix, "next", ...suffix]);
      `);

      const list = expectArrayExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectNoSpreadElement(list);
      expect(list.elements).toHaveLength(4);
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 0),
        "base"
      );
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 1),
        "middle"
      );
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 2),
        "next"
      );
      expectStringLiteralExpression(
        expectArrayElementExpression(list, 3),
        "last"
      );
    });

    it("applies object spread overrides in source order", () => {
      const results = reduceFixture(`
        const base = { color: "red", padding: 4 };
        const override = { color: "blue" };

        capture({
          color: "green",
          ...base,
          display: "block",
          ...override,
          padding: 8
        });
      `);

      const style = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectNoSpreadElement(style);
      expectObjectPropertyNames(style, ["color", "padding", "display"]);
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "color"),
        "blue"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(style, "padding"),
        8
      );
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "display"),
        "block"
      );
    });

    it("resolves static computed object keys", () => {
      const results = reduceFixture(`
        const colorKey = "color";
        const numericKey = 2;

        capture({
          [colorKey]: "red",
          ["padding"]: 4,
          [numericKey]: "two"
        });
      `);

      const style = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectObjectPropertyNames(style, ["color", "padding", "2"]);
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(style, "padding"),
        4
      );
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "2"),
        "two"
      );
      expectStaticObjectProperty(style, "2");
    });

    it("normalizes shorthand object properties", () => {
      const results = reduceFixture(`
        const color = "red";
        const padding = 4;

        capture({ color, padding });
      `);

      const style = expectObjectExpression(
        expectFixtureConfidentExpression(results, 0)
      );

      expectObjectPropertyNames(style, ["color", "padding"]);
      expectStringLiteralExpression(
        expectObjectPropertyExpression(style, "color"),
        "red"
      );
      expectNumericLiteralExpression(
        expectObjectPropertyExpression(style, "padding"),
        4
      );
      expectStaticObjectProperty(style, "color");
      expectStaticObjectProperty(style, "padding");
    });

    it("deopts non-static computed object keys", () => {
      const results = reduceFixture(`
        capture({ [props.key]: "red" });
      `);

      expect(expectFixtureDeoptResult(results, 0).reason).toBe(
        "non-static-object-key"
      );
    });

    it("deopts unsupported spread operands", () => {
      const results = reduceFixture(`
        const list = ["color"];
        const style = { color: "red" };

        capture({ ...list });
        capture([...style]);
        capture({ ...props.style });
        capture([...props.styles]);
      `);

      for (let index = 0; index < 4; index += 1) {
        expect(expectFixtureDeoptResult(results, index).reason).toBe(
          "unsupported-spread"
        );
      }
    });

    it("canonicalizes duplicate object method fallback keys", () => {
      const results = reduceFixture(`
        capture({ color: "red", color() { return "blue"; } });
      `);
      const fallback = expectObjectExpression(
        expectFixtureDeoptResult(results, 0).fallbackExpression
      );

      expect(fallback.properties).toHaveLength(1);
      expect(t.isObjectMethod(fallback.properties[0])).toBe(true);
    });
  });
}

function expectObjectProperty(
  expression: t.ObjectExpression,
  propertyName: string
): t.ObjectProperty {
  for (const property of expression.properties) {
    if (
      t.isObjectProperty(property) &&
      getStaticObjectPropertyName(property.key) === propertyName
    ) {
      return property;
    }
  }

  throw new Error(`expected object property ${propertyName}`);
}
