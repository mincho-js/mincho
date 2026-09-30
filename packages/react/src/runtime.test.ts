import type {
  ComplexPropDefinitions,
  PropTarget,
  RuntimeFn,
  VariantGroups,
  VariantObjectSelection
} from "@mincho-js/css";
import {
  type ComponentType,
  type ReactElement,
  type Ref,
  createElement,
  forwardRef
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { $$styled, $$styledChain } from "./runtime.js";

type Styles = RuntimeFn<
  VariantGroups,
  ComplexPropDefinitions<PropTarget | undefined>
>;

type Selection = VariantObjectSelection<VariantGroups>;

type Props = Record<string, unknown>;

function styleFn(
  variants: string[],
  callback: (selection: Selection) => unknown
) {
  const styles = callback as Styles;
  styles.variants = () => variants;

  return styles;
}

function render(
  component: unknown,
  props: Props,
  ref: Ref<unknown> = null
): ReactElement<Props> {
  return (
    component as {
      render: (props: Props, ref: Ref<unknown>) => ReactElement<Props>;
    }
  ).render(props, ref);
}

// A semantic reference for the previous implementation, including assignments
// to plain objects and its final spread. Deliberately do not use new helpers.
function referenceStyled(component: unknown, styles: Styles) {
  const variants = new Set(styles.variants());

  return forwardRef<unknown, Props>(
    ({ as, className: classNameProp, ...props }, ref) => {
      const selection: Selection = {};
      const otherProps: Props = {};

      for (const key of Object.keys(props)) {
        const value = props[key];

        if (variants.has(key)) {
          selection[key] = value as string | undefined;
        } else {
          otherProps[key] = value;
        }
      }

      const className = [styles(selection), classNameProp].join(" ");

      return createElement((as ?? component) as ComponentType<Props>, {
        ...otherProps,
        className,
        ref
      });
    }
  );
}

describe("styled runtime allocation paths", () => {
  it("keeps rest snapshot getter reads, symbols, and class coercion order", () => {
    function evaluate(factory: typeof referenceStyled) {
      const events: string[] = [];
      const symbol = Symbol("prop");
      const props = Object.defineProperties(
        {},
        {
          as: {
            enumerable: true,

            get: () => {
              events.push("as");

              return undefined;
            }
          },
          className: {
            enumerable: true,

            get: () => {
              events.push("className");

              return {
                toString: () => {
                  events.push("className.toString");

                  return "external";
                }
              };
            }
          },
          color: {
            enumerable: true,

            get: () => {
              events.push("color");

              return "blue";
            }
          },
          id: {
            enumerable: true,

            get: () => {
              events.push("id");

              return "root";
            }
          },
          [symbol]: {
            enumerable: true,

            get: () => {
              events.push("symbol");

              return "dropped";
            }
          }
        }
      );

      const styles = styleFn(["color"], (selection) => {
        events.push(`styles:${selection.color}`);

        return {
          toString: () => {
            events.push("styles.toString");

            return "blue";
          }
        };
      });

      const element = render(factory("div", styles), props);

      return { events, props: element.props };
    }

    const reference = evaluate(referenceStyled);
    const actual = evaluate($$styled as typeof referenceStyled);

    expect(actual).toEqual(reference);
    expect(actual.events).toEqual([
      "as",
      "className",
      "color",
      "id",
      "symbol",
      "styles:blue",
      "styles.toString",
      "className.toString"
    ]);
    expect(Object.getOwnPropertySymbols(actual.props)).toEqual([]);
  });

  it("allocates a fresh selection for arbitrary callables on every render", () => {
    const selections: Selection[] = [];
    const styles = styleFn([], (selection) => {
      selections.push(selection);

      return undefined;
    });

    const Target = () => null;

    const Styled = $$styled(Target, styles);
    const props = { className: "external", id: "root" };
    const first = render(Styled, props);
    const second = render(Styled, props);

    expect(first.type).toBe(Target);
    expect(second.type).toBe(Target);
    expect(first.props.className).toBe(" external");
    expect(second.props).toEqual(first.props);
    expect(selections).toEqual([{}, {}]);
    expect(selections[0]).not.toBe(selections[1]);
    expect(props).toEqual({ className: "external", id: "root" });
  });

  it("retains inherited setter effects and normalizes __proto__ props", () => {
    const setterKey = "minchoRuntimeSetterProbe";
    const events: unknown[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      setterKey
    );

    Object.defineProperty(Object.prototype, setterKey, {
      configurable: true,

      set: (value) => events.push(value)
    });

    try {
      const styles = styleFn([], () => "base");
      const props = Object.defineProperties(
        {},
        {
          [setterKey]: { enumerable: true, value: "setter" },
          ["__proto__"]: {
            enumerable: true,
            value: { key: "inherited-key", id: "inherited-id" }
          }
        }
      );

      const reference = render(referenceStyled("div", styles), props);
      const actual = render(
        $$styled("div" as unknown as ComponentType<unknown>, styles),
        props
      );

      expect(events).toEqual(["setter", "setter"]);
      expect(actual.props).toEqual(reference.props);
      expect(actual.key).toBe(reference.key);
      expect(actual.key).toBeNull();
      expect(actual.props).not.toHaveProperty("id");
      expect(Object.getPrototypeOf(actual.props)).toBe(Object.prototype);
    } finally {
      if (descriptor) {
        Object.defineProperty(Object.prototype, setterKey, descriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, setterKey);
      }
    }
  });

  it("uses own data properties when reserved prototype accessors exist", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "className"
    );

    const events: string[] = [];
    Object.defineProperty(Object.prototype, "className", {
      configurable: true,

      set(value: string) {
        events.push(value);
        Object.defineProperty(this, "className", {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
      }
    });

    try {
      const styles = styleFn([], () => "base");
      const props = { id: "root" };
      const reference = render(referenceStyled("div", styles), props);
      const referenceEvents = events.splice(0);
      const actual = render(
        $$styled("div" as unknown as ComponentType<unknown>, styles),
        props
      );

      const actualEvents = events.splice(0);

      expect(actual.props).toEqual(reference.props);
      expect(actualEvents).toEqual(referenceEvents);
    } finally {
      if (descriptor) {
        Object.defineProperty(Object.prototype, "className", descriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, "className");
      }
    }
  });

  it("keeps the final spread after styles when a setter installs accessors", () => {
    const setterKey = "minchoRuntimeAccessorProbe";
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      setterKey
    );

    const events: string[] = [];
    Object.defineProperty(Object.prototype, setterKey, {
      configurable: true,

      set() {
        events.push("setter");
        Object.defineProperty(this, "ref", {
          enumerable: true,

          get: () => {
            events.push("ref getter");

            return undefined;
          }
        });
      }
    });

    try {
      const styles = styleFn([], () => {
        events.push("styles");

        return "base";
      });

      const props = { [setterKey]: true };
      const reference = render(referenceStyled("div", styles), props);
      const referenceEvents = events.splice(0);
      const actual = render(
        $$styled("div" as unknown as ComponentType<unknown>, styles),
        props
      );

      expect(actual.props).toEqual(reference.props);
      expect(events).toEqual(referenceEvents);
      expect(events).toEqual(["setter", "styles", "ref getter"]);
    } finally {
      if (descriptor) {
        Object.defineProperty(Object.prototype, setterKey, descriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, setterKey);
      }
    }
  });

  it("forwards refs and custom as targets unchanged", () => {
    const Target = () => null;

    const Override = () => null;

    const styles = styleFn([], () => "base");
    const Styled = $$styled(Target, styles);
    const ref = { current: null };
    const actual = render(Styled, { as: Override, title: "override" }, ref);

    expect(actual.type).toBe(Override);
    expect(actual.props.ref).toBe(ref);
    expect(actual.props.title).toBe("override");
    expect(actual.props).not.toHaveProperty("as");
  });
});

describe("compiler-selected styled chains", () => {
  it("consumes child variants first without merging parent defaults", () => {
    const events: Array<[string, Selection]> = [];
    const parentStyles = styleFn(["tone", "size"], (selection) => {
      events.push(["parent", { ...selection }]);

      return `parent-${selection.tone ?? "default"}-${selection.size}`;
    });

    const childStyles = styleFn(["tone"], (selection) => {
      events.push(["child", { ...selection }]);

      return `child-${selection.tone}`;
    });

    const Parent = $$styled(
      "button" as unknown as ComponentType<unknown>,
      parentStyles
    );

    const Child = $$styled(Parent as ComponentType<unknown>, childStyles);
    const Chain = $$styledChain("button", [
      { styles: childStyles, variantKeys: ["tone"] },
      { styles: parentStyles, variantKeys: ["tone", "size"] }
    ]);

    const props = {
      tone: "brand",
      size: "small",
      children: "Buy",
      className: "external",
      id: "button"
    };

    const reference = renderToStaticMarkup(createElement(Child, props));
    const referenceEvents = events.splice(0);
    const actual = renderToStaticMarkup(createElement(Chain, props));

    expect(actual).toBe(reference);
    expect(events).toEqual(referenceEvents);
    expect(events).toEqual([
      ["child", { tone: "brand" }],
      ["parent", { size: "small" }]
    ]);
    expect(actual).toContain(
      'class="parent-default-small child-brand external"'
    );
  });

  it("retains empty class segments, trailing spaces, and stable target identity", () => {
    const empty = styleFn([], () => "");
    const parent = styleFn([], () => "parent");
    const Chain = $$styledChain("div", [
      { styles: empty, variantKeys: [] },
      { styles: parent, variantKeys: [] }
    ]);

    const first = render(Chain, {});
    const second = render(Chain, {});

    expect(first.type).toBe("div");
    expect(second.type).toBe(first.type);
    expect(first.props.className).toBe("parent  ");
    expect(second.props.className).toBe(first.props.className);
  });

  it("bypasses parent styles for an outer as override", () => {
    const events: string[] = [];
    const child = styleFn(["tone"], () => {
      events.push("child");

      return "child";
    });

    const parent = styleFn(["size"], () => {
      events.push("parent");

      return "parent";
    });

    const Chain = $$styledChain("div", [
      { styles: child, variantKeys: ["tone"] },
      { styles: parent, variantKeys: ["size"] }
    ]);

    const ref = { current: null };
    const element = render(
      Chain,
      { as: "button", tone: "brand", size: "small" },
      ref
    );

    expect(events).toEqual(["child"]);
    expect(element.type).toBe("button");
    expect(element.props.className).toBe("child ");
    expect(element.props.size).toBe("small");
    expect(element.props.ref).toBe(ref);
  });
});
