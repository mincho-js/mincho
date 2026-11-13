import {
  css as literalCss,
  globalCss,
  globalLayer,
  selectors
} from "@mincho-js/css";
import type {
  CSSRule,
  GlobalCSSRule,
  DefineRulesRules,
  DefineRulesPatternInput
} from "@mincho-js/css";
import {
  defineRules as adaptRules,
  type StyledComponent
} from "@mincho-js/react";
import type { ComponentPropsWithRef } from "react";

export type Definition = {
  css: ((...args: never[]) => string) & { raw: (...args: never[]) => CSSRule };
  rules: (...args: never[]) => unknown;
  cx: (...args: never[]) => string;
  preset: object;
};

type NativeInput<D extends Definition> =
  D["rules"] extends DefineRulesRules<
    infer Input,
    infer _Context,
    infer _Validate
  >
    ? Input
    : never;

/** Native Mincho values and conditions, with a Theme UI inheritance path. */
export type ComponentGroups<D extends Definition> = Record<
  string,
  Record<string, NativeInput<D> & { variant?: string }>
>;

export type ComponentGroupsInput<D extends Definition, Groups> =
  D["rules"] extends DefineRulesRules<
    infer Input,
    infer _Context,
    infer Validate
  >
    ? {
        [Group in keyof Groups]: {
          [Variant in keyof Groups[Group]]: Exclude<
            keyof Groups[Group][Variant],
            keyof Input | "variant"
          > extends never
            ? unknown
            : never;
        };
      } & (Validate extends true
        ? {
            [Group in keyof Groups]: DefineRulesPatternInput<
              { variants: { variant: Groups[Group] } },
              Input,
              true
            > extends never
              ? never
              : unknown;
          }
        : unknown)
    : never;

// Component defaults follow Theme UI's Box and semantic primitive components.
const primitives = {
  Box: { tag: "div", group: "variants" },
  Flex: { tag: "div", group: "variants", styles: { display: "flex" } },
  Grid: { tag: "div", group: "grids", styles: { display: "grid", gap: 3 } },
  Text: { tag: "span", group: "text", defaultVariant: "default" },
  Heading: {
    tag: "h2",
    group: "text",
    defaultVariant: "heading",
    styles: {
      fontFamily: "heading",
      fontWeight: "heading",
      lineHeight: "heading"
    }
  },
  Paragraph: {
    tag: "p",
    group: "text",
    defaultVariant: "paragraph",
    styles: { fontFamily: "body", fontWeight: "body", lineHeight: "body" }
  },
  Button: {
    tag: "button",
    group: "buttons",
    defaultVariant: "primary",
    styles: {
      appearance: "none",
      display: "inline-block",
      textAlign: "center",
      lineHeight: "inherit",
      textDecoration: "none",
      fontSize: "inherit",
      px: 3,
      py: 2,
      color: "white",
      bg: "primary",
      border: 0,
      borderRadius: 4,
      "&[hidden]": { display: "none" }
    }
  },
  Link: { tag: "a", group: "links", defaultVariant: "styles.a" },
  Card: { tag: "div", group: "cards", defaultVariant: "primary" },
  Container: {
    tag: "div",
    group: "layout",
    defaultVariant: "container",
    styles: { width: "100%", maxWidth: "container", mx: "auto" }
  },
  Label: {
    tag: "label",
    group: "forms",
    defaultVariant: "label",
    styles: { width: "100%", display: "flex" }
  },
  Image: {
    tag: "img",
    group: "images",
    styles: { maxWidth: "100%", height: "auto" }
  },
  Divider: {
    tag: "hr",
    group: "variants",
    defaultVariant: "styles.hr",
    styles: { color: "gray", m: 0, my: 2, border: 0, borderBottom: "1px solid" }
  }
} as const;

type Primitive = keyof typeof primitives;
type Path<Groups> = {
  [Group in keyof Groups & string]: `${Group}.${keyof Groups[Group] & string}`;
}[keyof Groups & string];
type RelativeVariant<
  Groups,
  Name extends Primitive
> = (typeof primitives)[Name]["group"] extends keyof Groups
  ? keyof Groups[(typeof primitives)[Name]["group"]] & string
  : never;
type DefaultVariant<Name extends Primitive> =
  (typeof primitives)[Name] extends {
    defaultVariant: infer Value extends string;
  }
    ? Value
    : never;

export type Components<Groups> = {
  [Name in Primitive]: StyledComponent<
    Omit<ComponentPropsWithRef<(typeof primitives)[Name]["tag"]>, "variant">,
    (typeof primitives)[Name]["tag"],
    {
      variant: Record<
        Path<Groups> | RelativeVariant<Groups, Name> | DefaultVariant<Name>,
        never
      >;
    }
  >;
};

type StyleObject = Record<string, unknown>;
const groupNames = [
  "variants",
  "text",
  "buttons",
  "cards",
  "forms",
  "links",
  "images",
  "grids",
  "layout",
  "styles"
] as const;

export type SourceGroups<Source> = Pick<
  Source,
  Extract<keyof Source, (typeof groupNames)[number]>
>;
export type MergedGroups<Source, Overrides> = {
  [
    Group in keyof SourceGroups<Source> | keyof Overrides
  ]: (Group extends keyof Source ? Source[Group] : Record<never, never>) &
    (Group extends keyof Overrides ? Overrides[Group] : Record<never, never>);
};

function isObject(value: unknown): value is StyleObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atPath(source: StyleObject, path: string): unknown {
  let value: unknown = source;

  for (const key of path.split(".")) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }

  return value;
}

function assertNativeValues(value: unknown): void {
  if (Array.isArray(value)) {
    throw new Error(
      "Theme UI components use Mincho condition objects, such as { base: 2, _sm: 3 }, instead of responsive arrays."
    );
  }

  if (isObject(value)) {
    for (const child of Object.values(value)) assertNativeValues(child);
  }
}

function mergeGroups(source: StyleObject, groups: StyleObject): StyleObject {
  const merged = { ...source };

  for (const [group, variants] of Object.entries(groups)) {
    if (!isObject(variants)) {
      throw new Error(
        `Theme UI component group ${JSON.stringify(group)} must be an object.`
      );
    }

    const previous = isObject(source[group]) ? source[group] : {};
    const next = { ...previous };

    for (const [name, style] of Object.entries(variants)) {
      if (!isObject(style)) {
        throw new Error(
          `Theme UI variant ${JSON.stringify(`${group}.${name}`)} must be a style object.`
        );
      }

      assertNativeValues(style);
      next[name] = {
        ...(isObject(previous[name]) ? previous[name] : {}),
        ...style
      };
    }

    merged[group] = next;
  }

  return merged;
}

// Source Theme UI style objects use implicit descendant selectors. Native
// Mincho input keeps its explicit selector and named condition syntax.
function normalizeStockStyle(style: StyleObject): StyleObject {
  return Object.fromEntries(
    Object.entries(style).map(([key, value]) => {
      if (!isObject(value)) return [key, normalizeSourceValue(value)];

      if (key === "selectors" || key.startsWith("@")) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([condition, child]) => [
              condition,
              isObject(child) ? normalizeStockStyle(child) : child
            ])
          )
        ];
      }

      return [selectors.nest("&", key), normalizeStockStyle(value)];
    })
  );
}

function normalizeStockSource(source: StyleObject): StyleObject {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      if (!isObject(value)) return [key, value];

      if (groupNames.includes(key as (typeof groupNames)[number])) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, style]) => [
              name,
              isObject(style) ? normalizeStockStyle(style) : style
            ])
          )
        ];
      }

      // Named root styles, such as dark.prism, can be inheritance targets too.
      return [key, normalizeStockStyle(value)];
    })
  );
}

// Only stock Theme UI source data uses responsive arrays. Public component
// groups are validated above and use Mincho's named condition objects.
function normalizeSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const conditions = ["base", "_sm", "_md", "_lg"];

    if (value.length > conditions.length) {
      throw new Error(
        "A stock Theme UI responsive value exceeds the preset's breakpoints."
      );
    }

    return Object.fromEntries(
      value.flatMap((item, index) =>
        item == null ? [] : [[conditions[index], normalizeSourceValue(item)]]
      )
    );
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeSourceValue(child)
      ])
    );
  }

  return value;
}

function resolveStyle(
  source: StyleObject,
  style: StyleObject,
  activePaths: readonly string[] = []
): StyleObject {
  let result: StyleObject = {};

  for (const [key, value] of Object.entries(style)) {
    if (key === "variant") {
      if (typeof value !== "string") {
        throw new Error(
          "A Theme UI variant inheritance path must be a string."
        );
      }

      if (activePaths.includes(value)) {
        throw new Error(
          `Circular Theme UI variant inheritance: ${[...activePaths, value].join(" -> ")}`
        );
      }

      const inherited = atPath(source, value);

      if (!isObject(inherited)) {
        throw new Error(
          `Unknown Theme UI variant inheritance path ${JSON.stringify(value)}.`
        );
      }

      result = {
        ...result,
        ...resolveStyle(source, inherited, [...activePaths, value])
      };
    } else if (isObject(value)) {
      result[key] = resolveStyle(source, value, activePaths);
    } else {
      result[key] = normalizeSourceValue(value);
    }
  }

  return result;
}

/** Internal source boundary: raw upstream values retain native token-or-CSS fallback. */
export function compileComponents<D extends Definition>(
  definition: D,
  groups: StyleObject,
  stockSource: StyleObject = {}
): Components<StyleObject> {
  const source = mergeGroups(normalizeStockSource(stockSource), groups);
  const entries = new Set([...groupNames, ...Object.keys(groups)]);
  const paths = [...entries].flatMap((group) =>
    isObject(source[group])
      ? Object.keys(source[group]).map((name) => `${group}.${name}`)
      : []
  );
  const styled = adaptRules(definition).styled as unknown as (
    tag: (typeof primitives)[Primitive]["tag"],
    options: unknown
  ) => unknown;

  const raw = definition.css.raw as (style: StyleObject) => CSSRule;

  function prepareSelectors(style: StyleObject): StyleObject {
    return Object.fromEntries(
      Object.entries(style).map(([key, value]) => {
        if (!isObject(value)) return [key, value];

        if (key === "selectors" || key.startsWith("@")) {
          return [
            key,
            Object.fromEntries(
              Object.entries(value).map(([condition, child]) => [
                condition,
                isObject(child) ? raw(prepareSelectors(child)) : child
              ])
            )
          ];
        }

        if (key.includes("&") || key.startsWith(":") || key.startsWith("[")) {
          return [key, raw(prepareSelectors(value))];
        }

        return [key, key.startsWith("_") ? prepareSelectors(value) : value];
      })
    );
  }

  const baseLayer = globalLayer("mincho-theme-ui-base");
  const variantLayer = globalLayer("mincho-theme-ui-variants");
  const cache = new Map<string, string>();

  function compileStyle(style: StyleObject, layer: string): string {
    const rule = raw(prepareSelectors(style));
    const key = JSON.stringify([layer, rule]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const className = literalCss({});
    globalCss(`.${className}`, {
      "@layer": { [layer]: rule }
    } as GlobalCSSRule);
    cache.set(key, className);
    return className;
  }

  return Object.fromEntries(
    Object.entries(primitives).map(([name, spec]) => {
      const group = source[spec.group];
      const relative = isObject(group) ? Object.keys(group) : [];
      const defaultVariant =
        "defaultVariant" in spec ? spec.defaultVariant : undefined;
      const names = new Set([
        ...paths,
        ...relative,
        ...(defaultVariant ? [defaultVariant] : [])
      ]);
      const variants = Object.fromEntries(
        [...names].map((variant) => {
          const selected =
            atPath(source, `${spec.group}.${variant}`) ||
            atPath(source, variant);

          return [
            variant,
            compileStyle(
              isObject(selected) ? resolveStyle(source, selected) : {},
              variantLayer
            )
          ];
        })
      );
      const base = {
        boxSizing: "border-box",
        margin: 0,
        minWidth: 0,
        ...("styles" in spec ? spec.styles : {})
      };

      return [
        name,
        styled(spec.tag, {
          base: compileStyle(base, baseLayer),
          variants: { variant: variants },
          ...(defaultVariant
            ? { defaultVariants: { variant: defaultVariant } }
            : {})
        })
      ];
    })
  ) as Components<StyleObject>;
}

/** Compile the standard primitives with a consumer's own native definition. */
export function createComponents<
  D extends Definition,
  const Groups extends ComponentGroups<D>
>(
  definition: D,
  groups: Groups & ComponentGroupsInput<D, NoInfer<Groups>>
): Components<Groups> {
  return compileComponents(definition, groups) as Components<Groups>;
}
