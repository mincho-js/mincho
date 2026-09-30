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
  type Ref,
  createElement,
  forwardRef
} from "react";

type StyledRecipe = RuntimeFn<
  VariantGroups,
  ComplexPropDefinitions<PropTarget | undefined>
>;

type StyledProps = {
  as?: ElementType;
  className?: string;
  [key: string]: unknown;
};

export function $$styled<T extends ComponentType<unknown>>(
  component: T,
  styles: StyledRecipe
) {
  type Props = ComponentProps<typeof component> & StyledProps;

  const variantKeys = getVariantKeys(styles);

  const StyledComponent = forwardRef<unknown, Props>(
    ({ as, className: classNameProp, ...props }, ref) => {
      const componentToRender = as ?? component;

      const variantSelection: VariantObjectSelection<VariantGroups> = {};
      const otherProps: Record<string, unknown> = {};
      const canReuseProps = splitVariantProps(
        props,
        variantKeys,
        variantSelection,
        otherProps
      );

      const className = [styles(variantSelection), classNameProp].join(" ");

      return createElement(
        componentToRender as ComponentType<{
          className?: string;
          ref?: unknown;
          [key: string]: unknown;
        }>,
        withClassNameAndRef(otherProps, className, ref, canReuseProps)
      );
    }
  );

  return StyledComponent;
}

/** @internal Emitted only for a compiler-proven local styled chain. */
export function $$styledChain(
  component: string,
  stages: readonly {
    styles: StyledRecipe;
    variantKeys: readonly string[];
  }[]
) {
  const compiledStages = stages.map(({ styles, variantKeys }) => ({
    styles,
    variantKeys: new Set(variantKeys)
  }));

  return forwardRef<unknown, StyledProps>(
    ({ as, className: classNameProp, ...props }, ref) => {
      let remainingProps = props;
      let className = classNameProp;
      let canReuseProps = false;

      // An outer `as` bypasses its styled parent, as in an ordinary chain.
      const stageCount = as == null ? compiledStages.length : 1;

      for (let index = 0; index < stageCount; index += 1) {
        const { styles, variantKeys } = compiledStages[index]!;
        const variantSelection: VariantObjectSelection<VariantGroups> = {};
        const otherProps: Record<string, unknown> = {};
        canReuseProps = splitVariantProps(
          remainingProps,
          variantKeys,
          variantSelection,
          otherProps
        );
        remainingProps = otherProps;
        className = [styles(variantSelection), className].join(" ");
      }

      return createElement(
        (as ?? component) as ComponentType<StyledProps>,
        withClassNameAndRef(remainingProps, className, ref, canReuseProps)
      );
    }
  );
}

function getVariantKeys(styles: StyledRecipe) {
  return new Set(styles.variants());
}

function splitVariantProps(
  props: Record<string, unknown>,
  variantKeys: ReadonlySet<string>,
  variantSelection: VariantObjectSelection<VariantGroups>,
  otherProps: Record<string, unknown>
): boolean {
  const keys = Object.keys(props);

  // Keep larger dynamic shapes on the engine's optimized object-spread path.
  let canReuseProps = keys.length <= 1;

  for (const key of keys) {
    const value = props[key];

    if (variantKeys.has(key)) {
      variantSelection[key] = value as string | undefined;
    } else {
      canReuseProps &&= !(key in otherProps);
      otherProps[key] = value;
    }
  }

  return canReuseProps;
}

function withClassNameAndRef(
  props: Record<string, unknown>,
  className: unknown,
  ref: Ref<unknown>,
  canReuseProps: boolean
): Record<string, unknown> {
  // Inherited assignments may change the prototype or install accessors. Keep
  // the original spread in that case, and when reserved props are inherited.
  if (
    canReuseProps &&
    !("className" in props) &&
    (!("ref" in props) || Object.prototype.hasOwnProperty.call(props, "ref"))
  ) {
    props.className = className;
    props.ref = ref;

    return props;
  }

  return { ...props, className, ref };
}

// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
const vitest = import.meta.vitest;

if (vitest) {
  const { describe, it, expect } = vitest;

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
