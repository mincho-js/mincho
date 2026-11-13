import type {
  ComplexPropDefinitions,
  DefineRulesPatternOptions,
  DefineRulesRules,
  PropDefinitionOutput,
  PropTarget,
  VariantGroups
} from "@mincho-js/css";
import { usesPixelUnits } from "@mincho-js/transform-to-vanilla";
import type { ComponentProps } from "react";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import type { StyledComponent } from "./index.js";
import type { $$styled } from "./runtime.js";
import { tags, type SupportedElements } from "./tags.js";

type Variants = Record<string, Record<string, unknown>> | undefined;
type Props = ComplexPropDefinitions<PropTarget> | undefined;
type PropDefinitions = Exclude<NonNullable<Props>, readonly unknown[]>;

type NativeProps<
  Tag extends SupportedElements,
  Groups,
  Definitions extends Props
> = Omit<
  ComponentProps<Tag>,
  | (Groups extends undefined ? never : keyof Groups)
  | ([Definitions] extends [undefined]
      ? never
      : keyof PropDefinitionOutput<Exclude<Definitions, undefined>>)
>;

interface Definition {
  css: (...args: never[]) => string;
  rules: (options: never) => unknown;
  cx: (...args: never[]) => string;
  preset: object;
}

type DefinitionStyled<Value extends Definition> =
  Value["rules"] extends DefineRulesRules<infer Input, infer Context>
    ? ScopedStyled<Input, Context>
    : never;
type ResolvedVariants<Groups> = {
  [Group in keyof Exclude<Groups, undefined>]: {
    [
      Value in keyof Exclude<Groups, undefined>[Group]
    ]: VariantGroups[string][string];
  };
};

type ScopedStyled<Input, Context> = {
  <
    Tag extends SupportedElements,
    Groups extends Exclude<Variants, undefined>,
    Definitions extends Props = undefined
  >(
    tag: Tag,
    options: DefineRulesPatternOptions<Input, Context, Groups, Definitions> & {
      variants: Groups;
    }
  ): StyledComponent<
    NativeProps<Tag, Groups, Definitions>,
    Tag,
    ResolvedVariants<Groups>,
    Definitions
  >;
  <
    Tag extends SupportedElements,
    Groups extends Variants = undefined,
    Definitions extends Props = undefined
  >(
    tag: Tag,
    options: DefineRulesPatternOptions<Input, Context, Groups, Definitions>
  ): StyledComponent<
    NativeProps<Tag, Groups, Definitions>,
    Tag,
    ResolvedVariants<Groups>,
    Definitions
  >;
} & {
  [Tag in SupportedElements]: ScopedStyledTag<Tag, Input, Context>;
};

interface ScopedStyledTag<Tag extends SupportedElements, Input, Context> {
  <
    Groups extends Exclude<Variants, undefined>,
    Definitions extends Props = undefined
  >(
    options: DefineRulesPatternOptions<Input, Context, Groups, Definitions> & {
      variants: Groups;
    }
  ): StyledComponent<
    NativeProps<Tag, Groups, Definitions>,
    Tag,
    ResolvedVariants<Groups>,
    Definitions
  >;
  <Groups extends Variants = undefined, Definitions extends Props = undefined>(
    options: DefineRulesPatternOptions<Input, Context, Groups, Definitions>
  ): StyledComponent<
    NativeProps<Tag, Groups, Definitions>,
    Tag,
    ResolvedVariants<Groups>,
    Definitions
  >;
}

/** Adds statically compiled React intrinsic components to a CSS definition. */
export function defineRules<Value extends Definition>(definition: Value) {
  const createRecipe = definition.rules as (
    options: unknown
  ) => Parameters<typeof $$styled>[1];

  function createStyled(tag: SupportedElements, options: unknown) {
    if (!tags.includes(tag)) {
      throw new Error(
        "React defineRules().styled requires an intrinsic element name"
      );
    }

    const props = (options as { props?: Props }).props;
    const propNames = Array.isArray(props)
      ? props.flatMap((prop) =>
          typeof prop === "string" ? [prop] : Object.keys(prop)
        )
      : Object.keys(props ?? {});
    const numericUnits: Record<string, "px" | "mixed"> = {};

    const normalizeProp = (prop: PropTarget | PropDefinitions) => {
      const entries: [string, PropDefinitions[string]][] =
        typeof prop === "string"
          ? [[prop, { targets: [prop] }]]
          : Object.entries(prop);
      const normalized = entries.map(([name, value]) => {
        const units = new Set(value?.targets.map(usesPixelUnits));
        const unit = units.has(true)
          ? units.has(false)
            ? "mixed"
            : "px"
          : undefined;

        if (unit) {
          Object.defineProperty(numericUnits, name, {
            value: unit,
            enumerable: true,
            configurable: true
          });
        } else {
          delete numericUnits[name];
        }

        if (typeof value?.base === "number") {
          if (value.base !== 0 && unit === "mixed") {
            throw new Error(
              `Dynamic prop "${name}" targets both length and unitless properties; use an explicit CSS string instead of a number`
            );
          }

          if (unit === "px") {
            return [name, { ...value, base: `${value.base}px` }] as const;
          }
        }

        return [name, value] as const;
      });

      return typeof prop === "string" ? prop : Object.fromEntries(normalized);
    };
    const normalizedProps = Array.isArray(props)
      ? props.map(normalizeProp)
      : props === undefined
        ? undefined
        : normalizeProp(props);
    const recipe = createRecipe(
      props === undefined
        ? options
        : { ...(options as object), props: normalizedProps }
    );

    const component = () => {
      throw new Error(
        "React defineRules().styled must be compiled in a CSS file, mincho$ block, or registered extractCalls module"
      );
    };

    return addFunctionSerializer(component, {
      importPath: "@mincho-js/react/runtime",
      importName: "$$styled",
      // Recipes carry their own function serializer; only their compiled
      // classes and variant selection data reach the React runtime.
      args: [
        tag,
        recipe as unknown as Parameters<
          typeof addFunctionSerializer
        >[1]["args"][number],
        ...(propNames.length > 0 ? [propNames] : []),
        ...(Object.keys(numericUnits).length > 0 ? [numericUnits] : [])
      ]
    });
  }

  const styled = Object.assign(
    createStyled,
    Object.fromEntries(
      tags.map((tag) => [
        tag,
        (options: Parameters<typeof createStyled>[1]) =>
          createStyled(tag, options)
      ])
    )
  ) as unknown as DefinitionStyled<Value>;

  // Preserve lazy getters, especially the preset snapshot that changes as
  // subsequent css/rules calls register new atoms on the definition.
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(definition),
      styled: {
        value: styled,
        enumerable: true,
        configurable: true,
        writable: true
      }
    }
  ) as Value & { styled: DefinitionStyled<Value> };
}
