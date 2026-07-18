import type {
  ComplexPropDefinitions,
  PropTarget,
  RuntimeFn,
  VariantGroups,
  VariantObjectSelection
} from "@mincho-js/css";
import {
  type ComponentProps,
  type ComponentType,
  type ElementType,
  createElement,
  forwardRef,
  useMemo
} from "react";

export function $$styled<T extends ComponentType<unknown>>(
  component: T,
  styles: RuntimeFn<
    VariantGroups,
    ComplexPropDefinitions<PropTarget | undefined>
  >
) {
  type Props = ComponentProps<typeof component> & {
    as?: ElementType;
    className?: string;
    // Add any variant props with an index signature
    [key: string]: unknown;
  };

  const variantKeys = getVariantKeys(styles);

  const StyledComponent = forwardRef<unknown, Props>(
    ({ as, className: classNameProp, ...props }, ref) => {
      const componentToRender = as ?? component;

      const [variantSelection, otherProps] = useMemo(() => {
        return splitVariantProps(props, variantKeys);
      }, [props, variantKeys]);

      const className = [styles(variantSelection), classNameProp].join(" ");

      // Create element with proper types
      if (typeof componentToRender === "string") {
        return createElement(componentToRender, {
          ...otherProps,
          className,
          ref
        });
      }

      return createElement(
        componentToRender as ComponentType<{
          className?: string;
          ref?: unknown;
          [key: string]: unknown;
        }>,
        {
          ...otherProps,
          className,
          ref
        }
      );
    }
  );

  // Set component static properties
  // StyledComponent.displayName = `Mincho(${getDisplayName(component)})`;

  return StyledComponent;
}

function getVariantKeys(
  styles: RuntimeFn<
    VariantGroups,
    ComplexPropDefinitions<PropTarget | undefined>
  >
) {
  return new Set(styles.variants());
}

function splitVariantProps(
  props: Record<string, unknown>,
  variantKeys: ReadonlySet<string>
): [VariantObjectSelection<VariantGroups>, Record<string, unknown>] {
  const variantSelection: VariantObjectSelection<VariantGroups> = {};
  const otherProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (variantKeys.has(key)) {
      variantSelection[key] = value as string | undefined;
    } else {
      otherProps[key] = value;
    }
  }

  return [variantSelection, otherProps];
}

// Helper function to get display name
// function getDisplayName(component: ComponentType<unknown>): string {
//   return component.displayName || component.name || "Component";
// }

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  type TestStyleFn = RuntimeFn<
    VariantGroups,
    ComplexPropDefinitions<PropTarget | undefined>
  >;

  function createTestStyles(
    variantKeys: string[],
    classByVariant: Record<string, Record<string, string>> = {}
  ) {
    const selections: Array<VariantObjectSelection<VariantGroups>> = [];
    const styles = ((selection: VariantObjectSelection<VariantGroups>) => {
      selections.push({ ...selection });

      const variantClassNames = Object.entries(selection)
        .map(([key, value]) => classByVariant[key]?.[String(value)])
        .filter(Boolean);

      return ["base", ...variantClassNames].join(" ");
    }) as TestStyleFn;

    styles.props = () => ({});
    styles.variants = () => variantKeys;
    styles.classNames = {
      base: "base",
      variants: {}
    };

    return { styles, selections };
  }

  describe("styled runtime", () => {
    it("styled runtime splits variants forwards props and preserves className order", async () => {
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { styles, selections } = createTestStyles(["color", "size"], {
        color: { brand: "color-brand" },
        size: { small: "size-small" }
      });
      const Button = $$styled(
        "button" as unknown as ComponentType<unknown>,
        styles
      );

      const markup = renderToStaticMarkup(
        createElement(Button, {
          children: "Buy",
          className: "explicit",
          color: "brand",
          id: "cta",
          size: "small",
          type: "button"
        })
      );

      expect(markup).toContain('class="base color-brand size-small explicit"');
      expect(markup).toContain('id="cta"');
      expect(markup).toContain('type="button"');
      expect(markup).not.toContain('color="brand"');
      expect(markup).not.toContain('size="small"');
      expect(selections).toEqual([{ color: "brand", size: "small" }]);
    });

    it("styled runtime handles missing falsey and as override props", async () => {
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { styles, selections } = createTestStyles(["disabled"], {
        disabled: { false: "disabled-false" }
      });
      const Panel = $$styled(
        "section" as unknown as ComponentType<unknown>,
        styles
      );

      const markup = renderToStaticMarkup(
        createElement(Panel, {
          as: "a",
          children: "Edge",
          "data-count": 0,
          disabled: false,
          href: "/edge",
          title: null
        })
      );

      expect(markup).toContain("<a ");
      expect(markup).toContain('class="base disabled-false "');
      expect(markup).toContain('data-count="0"');
      expect(markup).toContain('href="/edge"');
      expect(markup).not.toContain("<section");
      expect(markup).not.toContain("disabled=");
      expect(markup).not.toContain("title=");
      expect(selections).toEqual([{ disabled: false }]);
    });
  });
}
