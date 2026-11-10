import {
  defineRules as defineCssRules,
  type ComplexPropDefinitions,
  type PropTarget
} from "@mincho-js/css";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import type { Adapter } from "@vanilla-extract/css";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineRules } from "./defineRules.js";
import { $$styled } from "./runtime.js";

function materialize<Component>(component: Component): Component {
  const serializer = Object.getOwnPropertyDescriptor(
    component,
    "__recipe__"
  )!.value;

  return $$styled(
    ...(serializer.args as Parameters<typeof $$styled>)
  ) as Component;
}

function definition() {
  return defineCssRules({
    properties: {
      color: { accent: "#079b59", neutral: "#17231a" },
      paddingLeft: { compact: 4, comfortable: 12 },
      paddingRight: { compact: 4, comfortable: 12 }
    },
    shortcuts: { px: ["paddingLeft", "paddingRight"] },
    context: { defaultSpacing: "compact" as const }
  });
}

describe("React defineRules adapter", () => {
  beforeEach(() => setFileScope("react-definition.css.ts", "@test/react"));
  afterEach(() => endFileScope());

  it("preserves the original definition and adds typed intrinsic factories", () => {
    const core = definition();
    const react = defineRules(core);

    expect(react.css).toBe(core.css);
    expect(react.rules).toBe(core.rules);
    expect(react.cx).toBe(core.cx);
    expect(react.preset).toBe(core.preset);
    expect(core).not.toHaveProperty("styled");
    const initialPreset = react.preset;

    const Button = materialize(
      react.styled.button({
        base: (context) => ({ px: context.defaultSpacing }),
        variants: {
          tone: {
            accent: { color: "accent" },
            neutral: { color: "neutral" }
          }
        },
        defaultVariants: { tone: "accent" }
      })
    );
    core.css({ "@media (min-width: 37rem)": { color: "accent" } });
    expect(react.preset).toBe(core.preset);
    expect(react.preset).not.toBe(initialPreset);

    const html = renderToStaticMarkup(
      <Button tone="neutral" type="submit" className="consumer">
        Send
      </Button>
    );

    expect(html).toContain("<button");
    expect(html).toContain('type="submit"');
    expect(html).toContain("consumer");
    expect(html).not.toContain("tone=");
    expect(html).toContain("Send</button>");

    const typeCases = () => {
      // @ts-expect-error Variant selections retain the keys from the definition.
      <Button tone="missing" />;
      // @ts-expect-error Scoped styles accept only declared color tokens.
      react.styled.button({ base: { color: "missing-color" } });
      // @ts-expect-error Shortcut arguments use their mapped property tokens.
      react.styled.button({ base: { px: "missing-spacing" } });
    };

    void typeCases;
  });

  it("infers variants that are all context callbacks", () => {
    const { styled } = defineRules(definition());
    const Button = materialize(
      styled.button({
        variants: {
          spacing: {
            compact: (context) => ({ px: context.defaultSpacing }),
            comfortable: (context) => ({ px: context.defaultSpacing })
          }
        },
        defaultVariants: { spacing: "compact" }
      })
    );
    const Link = materialize(
      styled("a", {
        variants: {
          spacing: {
            compact: (context) => ({ px: context.defaultSpacing })
          }
        },
        defaultVariants: { spacing: "compact" }
      })
    );

    expect(renderToStaticMarkup(<Button spacing="comfortable" />)).toContain(
      "<button"
    );
    expect(
      renderToStaticMarkup(<Link spacing="compact" href="/docs" />)
    ).toContain('href="/docs"');
  });

  it("validates scalar recipe inputs while preserving object resolver values", () => {
    const core = defineCssRules({
      properties: {
        padding: (value: number) => Number(value.toFixed(0)),
        margin: (value: { amount?: number }) => value.amount ?? 0,
        color: { accent: "red", neutral: "gray" }
      },
      shortcuts: { p: ["padding"] },
      context: { defaultPadding: 2 as const }
    });
    const { styled } = defineRules(core);
    const options = {
      base: { padding: 2, margin: {} },
      variants: {
        active: { true: { p: 3 }, false: { color: "neutral" } }
      },
      defaultVariants: { active: true }
    } as const;
    const Dotted = materialize(styled.div(options));
    const Callable = materialize(styled("div", options));
    const Callback = materialize(
      styled.div({
        base: (context) => ({ padding: context.defaultPadding, margin: {} })
      })
    );
    const optionalOptions: { variants?: typeof options.variants } = options;
    const Optional = materialize(styled.div(optionalOptions));
    const OptionalCallable = materialize(styled("div", optionalOptions));

    for (const Component of [Dotted, Callable, Optional, OptionalCallable]) {
      const active = renderToStaticMarkup(<Component active />);
      const inactive = renderToStaticMarkup(<Component active={false} />);

      expect(active).not.toBe(inactive);
      expect(active).not.toContain("active=");
    }
    expect(renderToStaticMarkup(<Callback />)).toContain("class=");

    const typeCases = () => {
      // @ts-expect-error A scalar resolver requires a scalar or a nonempty condition map.
      styled.div({ base: { padding: {} } });
      // @ts-expect-error Callable factories share the scalar input contract.
      styled("div", { base: { padding: {} } });
      // @ts-expect-error Nested conditional leaves preserve the resolver input contract.
      styled.div({ base: { padding: { _hover: {} } } });
      // @ts-expect-error Context callbacks cannot return an empty scalar input.
      styled.div({ base: () => ({ padding: {} }) });
      // @ts-expect-error Variants share the scalar input contract.
      styled.div({ variants: { tone: { accent: { padding: {} } } } });
      // @ts-expect-error Callable variants share the scalar input contract.
      styled("div", { variants: { tone: { accent: { padding: {} } } } });
      // @ts-expect-error Scalar resolver types remain numeric.
      styled.div({ base: { padding: "bad" } });
      // @ts-expect-error Existing property keys still reject excess entries.
      styled.div({ base: { padding: 2, typo: 1 } });
      // @ts-expect-error Boolean variant selections keep their public type.
      <Dotted active="true" />;
      // @ts-expect-error Optional callable options preserve known variants.
      <OptionalCallable active="true" />;
    };

    void typeCases;
  });

  it("lets variants replace native props with the same name", () => {
    const { styled } = defineRules(definition());
    const options = {
      variants: {
        size: {
          compact: { px: "compact" },
          comfortable: { px: "comfortable" }
        }
      }
    } as const;
    const optionalOptions: { variants?: typeof options.variants } = options;
    const Input = materialize(styled.input(options));
    const CallableInput = materialize(styled("input", options));
    const OptionalInput = materialize(styled.input(optionalOptions));
    const OptionalCallableInput = materialize(styled("input", optionalOptions));
    const NativeInput = materialize(styled.input({}));

    for (const Component of [
      Input,
      CallableInput,
      OptionalInput,
      OptionalCallableInput
    ]) {
      const compact = renderToStaticMarkup(
        <Component size="compact" type="text" placeholder="Name" />
      );
      const comfortable = renderToStaticMarkup(
        <Component size="comfortable" type="text" placeholder="Name" />
      );

      expect(compact).not.toBe(comfortable);
      expect(compact).toContain('type="text"');
      expect(compact).toContain('placeholder="Name"');
      expect(compact).not.toContain("size=");
      expect(comfortable).not.toContain("size=");

      const typeCases = () => {
        // @ts-expect-error Variant keys replace the native numeric size prop.
        <Component size={12} />;
        // @ts-expect-error Only declared variant values are accepted.
        <Component size="missing" />;
      };

      void typeCases;
    }

    expect(renderToStaticMarkup(<NativeInput size={12} />)).toContain(
      'size="12"'
    );
  });

  it("serializes only the target tag and compiled recipe", () => {
    const react = defineRules(definition());
    const component = react.styled("a", {
      base: { color: "accent", px: "comfortable" }
    });
    const serializer = Object.getOwnPropertyDescriptor(
      component,
      "__recipe__"
    )!.value;

    expect(typeof component).toBe("function");
    expect(serializer.importPath).toBe("@mincho-js/react/runtime");
    expect(serializer.importName).toBe("$$styled");
    expect(serializer.args).toHaveLength(2);
    expect(serializer.args[0]).toBe("a");
    expect(serializer.args[1]()).toMatch(/\S/);
    expect(serializer.args[1]).toHaveProperty("__recipe__");
    const Link = materialize(component);

    expect(renderToStaticMarkup(<Link href="/docs">Docs</Link>)).toContain(
      'href="/docs"'
    );
  });

  it("maps declared dynamic props to CSS variables without forwarding them", () => {
    const { styled } = defineRules(defineCssRules({}));
    const Box = materialize(
      styled.div({
        props: [
          "color",
          { space: { targets: ["paddingLeft", "paddingRight"] } }
        ]
      })
    );
    const markup = renderToStaticMarkup(
      <Box color="red" space="12px" title="dynamic" style={{ margin: 4 }} />
    );

    expect(markup).toMatch(/--[^:;]+:red/);
    expect(markup).toMatch(/--[^:;]+:12px/);
    expect(markup).toContain("margin:4px");
    expect(markup).toContain('title="dynamic"');
    expect(markup).not.toContain('color="red"');
    expect(markup).not.toContain('space="12px"');
  });

  it.each(["as", "className", "key", "ref"])(
    "rejects reserved dynamic prop %s before compiling its recipe",
    (name) => {
      const core = definition();
      const createRecipe = vi.spyOn(core, "rules");
      const { styled } = defineRules(core);
      const declaration = {
        [name]: { targets: ["color"] }
      } satisfies ComplexPropDefinitions<PropTarget>;
      const definitions: ComplexPropDefinitions<PropTarget>[] = [
        declaration,
        ["color", declaration]
      ];

      for (const props of definitions) {
        const options = { base: { color: "accent" }, props } as const;
        const error = `Dynamic CSS prop "${name}" is reserved by React defineRules().styled`;

        expect(() => styled.div(options)).toThrow(error);
        expect(() => styled("div", options)).toThrow(error);
      }

      expect(createRecipe).not.toHaveBeenCalled();
    }
  );

  it.each(["as", "className", "key", "ref"])(
    "rejects reserved variant group %s before compiling its recipe",
    (name) => {
      const core = definition();
      const createRecipe = vi.spyOn(core, "rules");
      const { styled } = defineRules(core);
      const options = {
        base: { color: "neutral" },
        variants: { [name]: { active: { color: "accent" } } },
        defaultVariants: { [name]: "active" }
      } as const;
      const error = `Variant group "${name}" is reserved by React defineRules().styled`;

      expect(() => styled.div(options)).toThrow(error);
      expect(() => styled("div", options)).toThrow(error);
      expect(createRecipe).not.toHaveBeenCalled();
    }
  );

  it("keeps reserved words as values in ordinary variant groups", () => {
    const { styled } = defineRules(definition());
    const options = {
      variants: {
        tone: {
          as: { color: "accent" },
          className: { color: "neutral" },
          key: { px: "compact" },
          ref: { px: "comfortable" }
        }
      }
    } as const;

    for (const compiled of [styled.div(options), styled("div", options)]) {
      const serializer = Object.getOwnPropertyDescriptor(
        compiled,
        "__recipe__"
      )!.value;
      const recipe = serializer.args[1];
      const Box = materialize(compiled);

      for (const tone of ["as", "className", "key", "ref"] as const) {
        const markup = renderToStaticMarkup(
          <Box tone={tone} as="span" className="consumer" key={tone} />
        );

        expect(markup).toContain("<span");
        expect(markup).toContain(`class="${recipe({ tone })} consumer"`);
        expect(markup).not.toContain("tone=");
      }
    }
  });

  it("serializes numeric length props with units and leaves unitless values unchanged", () => {
    const { styled } = defineRules(defineCssRules({}));
    const Compiled = styled.div({
      props: [
        "width",
        "opacity",
        { space: { targets: ["paddingLeft", "paddingRight"] } }
      ]
    });
    const serializer = Object.getOwnPropertyDescriptor(
      Compiled,
      "__recipe__"
    )!.value;
    expect(serializer.args[3]).toEqual({ width: "px", space: "px" });

    const Box = materialize(Compiled);
    const markup = renderToStaticMarkup(
      <Box width={12} opacity={0.5} space={4} />
    );

    expect(markup).toMatch(/--[^:;]+:12px/);
    expect(markup).toMatch(/--[^:;]+:0.5/);
    expect(markup).toMatch(/--[^:;]+:4px/);
    expect(markup).not.toContain("width=");
    expect(markup).not.toContain("space=");

    const strings = renderToStaticMarkup(
      <Box width="12rem" space="calc(2em + 1px)" opacity={0} />
    );
    expect(strings).toMatch(/--[^:;]+:12rem/);
    expect(strings).toMatch(/--[^:;]+:calc\(2em \+ 1px\)/);
    expect(strings).toMatch(/--[^:;]+:0[;"]/);
  });

  it("requires explicit strings for props combining length and unitless targets", () => {
    const { styled } = defineRules(defineCssRules({}));
    const Box = materialize(
      styled.div({ props: { amount: { targets: ["width", "opacity"] } } })
    );

    expect(() => renderToStaticMarkup(<Box amount={12} />)).toThrow(
      /amount.*length and unitless.*string/
    );
    expect(renderToStaticMarkup(<Box amount="inherit" />)).toMatch(
      /--[^:;]+:inherit/
    );
    expect(renderToStaticMarkup(<Box amount={0} />)).toMatch(/--[^:;]+:0[;"]/);
  });

  it.each([
    ["length to unitless", ["width"], ["opacity"], 0.25, 0.5, ""],
    ["mixed to unitless", ["width", "opacity"], ["opacity"], 0.25, 0.5, ""],
    ["unitless to length", ["opacity"], ["width"], 12, 24, "px"]
  ] as const)(
    "uses the last repeated dynamic prop's units from %s",
    (_name, firstTargets, finalTargets, base, value, unit) => {
      const emitted: Parameters<Adapter["appendCss"]>[0][] = [];
      setAdapter({ ...mockAdapter, appendCss: (rule) => emitted.push(rule) });

      try {
        const { styled } = defineRules(defineCssRules({}));
        const Box = materialize(
          styled.div({
            props: [
              { amount: { targets: [...firstTargets], base: 0 } },
              { amount: { targets: [...finalTargets], base } }
            ]
          })
        );
        const target = finalTargets[0];
        const declaration = emitted
          .flatMap((entry) => (entry.type === "local" ? [entry] : []))
          .find((entry) => Object.hasOwn(entry.rule, target))!;
        const fallback = declaration.rule[target];

        expect(fallback).toEqual(
          expect.stringMatching(new RegExp(`, ${base}${unit}\\)$`))
        );
        const variable = String(fallback).match(/^var\((--[^,)]+)/)![1];
        const markup = renderToStaticMarkup(<Box amount={value} />);

        expect(markup).toContain(`style="${variable}:${value}${unit}"`);
        expect(markup).toContain(declaration.selector);
        expect(markup).not.toContain("amount=");
        expect(renderToStaticMarkup(<Box />)).not.toContain("style=");
      } finally {
        removeAdapter();
      }
    }
  );

  it.each(["object", "array"] as const)(
    "compiles numeric dynamic-prop defaults with matching units in %s definitions",
    (shape) => {
      const emitted: Parameters<Adapter["appendCss"]>[0][] = [];
      setAdapter({ ...mockAdapter, appendCss: (rule) => emitted.push(rule) });

      try {
        const props = {
          width: { targets: ["width"], base: 12 },
          space: { targets: ["paddingLeft", "paddingRight"], base: 4 },
          opacity: { targets: ["opacity"], base: 0.5 },
          lineHeight: { targets: ["lineHeight"], base: 1.5 },
          fontWeight: { targets: ["fontWeight"], base: 600 },
          top: { targets: ["top"], base: 0 },
          zero: { targets: ["height", "flexGrow"], base: 0 },
          mixed: { targets: ["minHeight", "zIndex"], base: "inherit" },
          gap: { targets: ["gap"], base: "2rem" }
        } satisfies ComplexPropDefinitions<PropTarget>;
        const { styled } = defineRules(defineCssRules({}));
        const Box = materialize(
          styled.div({ props: shape === "object" ? props : ["color", props] })
        );
        const markup = renderToStaticMarkup(<Box title="defaults" />);
        const localRules = emitted.flatMap((entry) =>
          entry.type === "local" ? [entry] : []
        );
        const declaration = localRules.find((entry) =>
          Object.hasOwn(entry.rule, "width")
        )!;

        expect(declaration.rule).toEqual(
          expect.objectContaining({
            width: expect.stringMatching(/, 12px\)$/),
            paddingLeft: expect.stringMatching(/, 4px\)$/),
            paddingRight: expect.stringMatching(/, 4px\)$/),
            opacity: expect.stringMatching(/, 0\.5\)$/),
            lineHeight: expect.stringMatching(/, 1\.5\)$/),
            fontWeight: expect.stringMatching(/, 600\)$/),
            top: expect.stringMatching(/, 0px\)$/),
            height: expect.stringMatching(/, 0\)$/),
            flexGrow: expect.stringMatching(/, 0\)$/),
            minHeight: expect.stringMatching(/, inherit\)$/),
            zIndex: expect.stringMatching(/, inherit\)$/),
            gap: expect.stringMatching(/, 2rem\)$/)
          })
        );
        expect(markup).toContain(declaration.selector);
        expect(markup).not.toContain("style=");
        expect(props.width.base).toBe(12);
        expect(props.space.base).toBe(4);
        expect(renderToStaticMarkup(<Box width={24} opacity={0.25} />)).toMatch(
          /--[^:;]+:24px;--[^:;]+:0\.25/
        );
      } finally {
        removeAdapter();
      }
    }
  );

  it.each(["object", "array"] as const)(
    "rejects nonzero mixed-target defaults before compiling %s definitions",
    (shape) => {
      const core = defineCssRules({});
      const createRecipe = vi.spyOn(core, "rules");
      const { styled } = defineRules(core);
      const props = {
        amount: { targets: ["width", "opacity"], base: 12 }
      } satisfies ComplexPropDefinitions<PropTarget>;
      const options = {
        props: shape === "object" ? props : [props]
      };

      expect(() => styled.div(options)).toThrow(
        /amount.*length and unitless.*string/
      );
      expect(() => styled("div", options)).toThrow(
        /amount.*length and unitless.*string/
      );
      expect(createRecipe).not.toHaveBeenCalled();
    }
  );

  it("lets dynamic props replace native props in object and array definitions", () => {
    const { styled } = defineRules(definition());
    const props = {
      size: { targets: ["width"] }
    } satisfies ComplexPropDefinitions<PropTarget>;
    const variants = { tone: { accent: { color: "accent" } } } as const;
    const optionalOptions: {
      props?: typeof props;
      variants?: typeof variants;
    } = { props, variants };
    const arrayProps = [
      "color",
      { size: { targets: ["width"] } }
    ] satisfies ComplexPropDefinitions<PropTarget>;
    const ObjectInput = materialize(styled.input({ props }));
    const ArrayInput = materialize(styled.input({ props: arrayProps }));
    const components = [
      ObjectInput,
      materialize(styled("input", { props })),
      materialize(styled.input({ props, variants })),
      materialize(styled("input", { props, variants })),
      materialize(styled.input(optionalOptions)),
      materialize(styled("input", optionalOptions)),
      ArrayInput,
      materialize(styled("input", { props: arrayProps }))
    ];

    for (const Input of components) {
      const markup = renderToStaticMarkup(
        <Input size="12rem" type="text" placeholder="Name" />
      );

      expect(markup).toMatch(/--[^:;]+:12rem/);
      expect(markup).toContain('type="text"');
      expect(markup).toContain('placeholder="Name"');
      expect(markup).not.toContain("size=");
    }

    const typeCases = () => {
      // @ts-expect-error Dynamic props retain their target CSS value types.
      <ObjectInput size={null} />;
      // @ts-expect-error Array definitions retain their target CSS value types.
      <ArrayInput size={null} />;
      // @ts-expect-error Unrelated native attributes retain their value types.
      <ObjectInput size="12rem" maxLength="long" />;
    };

    void typeCases;

    const UndefinedPropsInput = materialize(styled.input({ props: undefined }));
    const NeverPropsInput = materialize(
      styled<"input", undefined, never>("input", {})
    );

    expect(renderToStaticMarkup(<UndefinedPropsInput size={12} />)).toContain(
      'size="12"'
    );
    expect(renderToStaticMarkup(<NeverPropsInput size={12} />)).toContain(
      'size="12"'
    );
  });

  it("rejects component functions at the static serialization boundary", () => {
    const { styled } = defineRules(definition());

    expect(() => {
      // @ts-expect-error Arbitrary component functions cannot be serialized.
      styled(() => <button />, { color: "accent" });
    }).toThrow("requires an intrinsic element name");
  });
});
