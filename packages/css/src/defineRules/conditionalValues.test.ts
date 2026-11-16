import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";

import { defineRules } from "./index.js";

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("conditional-values.css.ts", "@test/define-rules");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("conditional token values", () => {
  it.each([undefined, "(min-width: 48rem)"])(
    "omits disabled aliases while retaining enabled conditions (%s)",
    (wide: string | undefined) => {
      const { css } = defineRules({
        properties: { color: { primary: "red", secondary: "blue" } },
        shortcuts: { text: "color", accent: { color: "primary" } },
        conditions: { wide, hover: undefined }
      });
      const conditional = wide
        ? { "@media": { [wide]: { color: "blue" } } }
        : {};

      expect(css.raw({ _wide: { text: "secondary" } })).toEqual(conditional);
      expect(
        css.raw({ color: { base: "primary", _wide: "secondary" } })
      ).toEqual({ color: "red", ...conditional });
      expect(css.raw({ text: { _wide: "secondary" } })).toEqual(conditional);
      expect(css.raw({ accent: { _wide: true } })).toEqual(
        wide ? { "@media": { [wide]: { color: "red" } } } : {}
      );
      expect(css.raw({ text: { _hover: { _wide: "secondary" } } })).toEqual(
        wide
          ? {
              "@media": {
                [wide]: { selectors: { "&:hover": { color: "blue" } } }
              }
            }
          : {}
      );
      expect(
        css.raw({ _wide: undefined, text: { _hover: undefined } })
      ).toEqual({});
      expect(css.raw({ _custom: { color: "red" } } as never)).toEqual({
        selectors: { "&:custom": { color: "red" } }
      });
      expect(css.raw({ text: { _hover: "secondary" } })).toEqual({
        selectors: { "&:hover": { color: "blue" } }
      });
    }
  );

  it("keeps empty fixed-shortcut condition maps inactive through aliases", () => {
    const { css } = defineRules({
      properties: { color: true },
      shortcuts: {
        accent: { color: "red" },
        brand: "accent",
        tone: ["brand"]
      }
    });

    expect(css.raw({ accent: {} })).toEqual({});
    expect(css.raw({ brand: {} })).toEqual({});
    expect(css.raw({ tone: {} })).toEqual({});
    expect(css.raw({ accent: { _hover: {} } })).toEqual({});
    expect(
      css.raw({ accent: { "@media": { "(min-width: 48rem)": {} } } })
    ).toEqual({});
    expect(css({ accent: {} })).toBe(css({}));
    expect(css.raw(["accent", { accent: false }])).toEqual({ color: "red" });
    expect(css.raw({ accent: { base: false, _hover: true } })).toEqual({
      selectors: { "&:hover": { color: "red" } }
    });
  });

  it("requires a value in scalar resolver condition maps", () => {
    const { css } = defineRules({
      properties: {
        color: (value: string) => value.toUpperCase(),
        opacity: (value: undefined) => value ?? 1,
        width: (value: never) => value
      },
      shortcuts: {
        text: "color",
        paint: (value: string) => ({ color: value.toUpperCase() }),
        foreground: ["text"]
      }
    });

    expect(css.raw({ color: { base: undefined } })).toEqual({});
    expect(css.raw({ text: { _hover: "red" } })).toEqual({
      selectors: { "&:hover": { color: "RED" } }
    });
    expect(css.raw({ paint: { "@media (min-width: 48rem)": "blue" } })).toEqual(
      {
        "@media": { "(min-width: 48rem)": { color: "BLUE" } }
      }
    );

    const typeCases = () => {
      // @ts-expect-error A scalar resolver cannot receive an empty object.
      css.raw({ color: {} });
      // @ts-expect-error An undefined parameter also cannot receive {}.
      css.raw({ opacity: {} });
      // @ts-expect-error A never parameter also cannot receive {}.
      css.raw({ width: {} });
      // @ts-expect-error Arrays preserve the scalar leaf requirement.
      css.raw([{ color: {} }]);
      // @ts-expect-error Context callbacks preserve the scalar leaf requirement.
      css.raw(() => ({ color: {} }));
      // @ts-expect-error A shortcut alias preserves the scalar resolver input.
      css.raw({ text: {} });
      // @ts-expect-error Functional shortcuts also require a scalar leaf.
      css.raw({ paint: {} });
      // @ts-expect-error Chained shortcut arrays preserve that requirement.
      css.raw({ foreground: {} });
      // @ts-expect-error Nested conditions cannot forward an empty scalar leaf.
      css.raw({ color: { _hover: {} } });
      // @ts-expect-error Grouped at-rules retain the scalar resolver requirement.
      css.raw({ text: { "@media": { "(min-width: 48rem)": {} } } });
      const inactive: { _hover?: string } = {};
      // @ts-expect-error An all-optional spread can still be empty.
      css({ color: { ...inactive } });
    };

    void typeCases;
  });

  it("preserves empty object arguments for property and shortcut resolvers", () => {
    const { css } = defineRules({
      properties: {
        color: ({ value = "black" }: { value?: string }) => value,
        opacity: true
      },
      shortcuts: {
        text: "color",
        alpha: ({ value = 1 }: { value?: number }) => ({ opacity: value })
      }
    });

    expect(css.raw({ color: {} })).toEqual({ color: "black" });
    expect(css.raw({ text: {} })).toEqual({ color: "black" });
    expect(css.raw({ alpha: {} })).toEqual({ opacity: 1 });
    expect(css.raw({ text: { _hover: {} }, alpha: { _focus: {} } })).toEqual({
      selectors: {
        "&:hover": { color: "black" },
        "&:focus": { opacity: 1 }
      }
    });
  });

  it("validates array resolver elements independently of array condition metadata", () => {
    type Values = Array<{ value?: string }>;
    const { css, rules } = defineRules({
      properties: {
        color: (values: Values) => values[0]?.value ?? "black"
      },
      shortcuts: { text: "color" }
    });
    const values: Values = [{}];

    expect(css.raw({ color: values })).toEqual({ color: "black" });
    expect(css.raw({ text: values })).toEqual({ color: "black" });
    expect(css.raw({ color: { base: values } })).toEqual({ color: "black" });
    expect(css.raw({ color: { _hover: values } })).toEqual({
      selectors: { "&:hover": { color: "black" } }
    });
    expect(rules.raw({ base: { color: values } }).base).toEqual({
      color: "black"
    });

    const invalidInputs = () => {
      // @ts-expect-error An array resolver cannot receive an empty object.
      css.raw({ color: {} });
      // @ts-expect-error Array elements retain their resolver field types.
      css.raw({ color: [{ value: 1 }] });
    };
    void invalidInputs;
  });

  it.each([
    "@value",
    "@value argument",
    "@mediaValue",
    "@supportsValue",
    "@containerValue",
    "@layerValue"
  ])(
    "preserves %s resolver data through direct and conditional shortcut values",
    (key) => {
      const { css } = defineRules({
        properties: {
          color: (value: Record<string, string>) => value[key],
          backgroundColor: true
        },
        shortcuts: {
          text: "color",
          paint: (value: Record<string, string>) => ({
            backgroundColor: value[key]
          })
        },
        conditions: { wide: "(min-width: 48rem)" }
      });
      const red = { [key]: "red" };
      const blue = { [key]: "blue" };

      expect(css.raw({ color: red })).toEqual({ color: "red" });
      expect(css.raw({ text: red })).toEqual({ color: "red" });
      expect(css.raw({ paint: red })).toEqual({ backgroundColor: "red" });
      expect(css.raw({ color: { _hover: blue } })).toEqual({
        selectors: { "&:hover": { color: "blue" } }
      });
      expect(
        css.raw({ text: { "@media": { "(min-width: 48rem)": blue } } })
      ).toEqual({
        "@media": { "(min-width: 48rem)": { color: "blue" } }
      });
      expect(css.raw({ paint: { _wide: blue } })).toEqual({
        "@media": { "(min-width: 48rem)": { backgroundColor: "blue" } }
      });
    }
  );

  it.each([
    ["@media", "(min-width: 48rem)"],
    ["@supports", "(display: grid)"],
    ["@container", "card (min-width: 20rem)"],
    ["@layer", "components"]
  ] as const)(
    "resolves %s conditions in inline and grouped forms",
    (atRule, query) => {
      const { css } = defineRules({
        properties: { color: { primary: "red" } },
        shortcuts: { text: "color" }
      });
      const expected = { [atRule]: { [query]: { color: "red" } } };

      expect(
        css.raw({ color: { [`${atRule} ${query}`]: "primary" as const } })
      ).toEqual(expected);
      expect(
        css.raw({ text: { [atRule]: { [query]: "primary" as const } } })
      ).toEqual(expected);
    }
  );

  it("preserves object resolver arguments in direct and conditional values", () => {
    const { css } = defineRules({
      properties: {
        color: ({ red, blue }: { red: number; blue: number }) =>
          `rgb(${red} 0 ${blue})`
      }
    });

    expect(css.raw({ color: { red: 255, blue: 0 } })).toEqual({
      color: "rgb(255 0 0)"
    });
    expect(
      css.raw({
        color: {
          base: { red: 255, blue: 0 },
          _hover: { red: 0, blue: 255 }
        }
      })
    ).toEqual({
      color: "rgb(255 0 0)",
      selectors: { "&:hover": { color: "rgb(0 0 255)" } }
    });
  });

  it("preserves condition-shaped resolver arguments at an explicit base value", () => {
    type Tone = { base: string; _hover?: string };
    const received: Tone[] = [];
    const resolveTone = (value: Tone) => {
      received.push(value);
      return value.base;
    };
    const { css } = defineRules({
      conditions: { wide: "@media (min-width: 60rem)" },
      properties: { color: resolveTone },
      shortcuts: {
        text: "color",
        tone: (value: Tone) => ({ backgroundColor: resolveTone(value) }),
        paint: "tone"
      }
    });
    const red = { base: "red" };
    const blue = { base: "blue", _hover: "data" };

    expect(css.raw({ color: { base: red } })).toEqual({ color: "red" });
    expect(css.raw({ text: { base: blue } })).toEqual({ color: "blue" });
    expect(css.raw({ tone: { base: red } })).toEqual({
      backgroundColor: "red"
    });
    expect(css.raw({ paint: { _wide: { _hover: { base: blue } } } })).toEqual({
      "@media": {
        "(min-width: 60rem)": {
          selectors: { "&:hover": { backgroundColor: "blue" } }
        }
      }
    });
    expect(
      css.raw({ text: { "@supports (display: grid)": { base: red } } })
    ).toEqual({
      "@supports": { "(display: grid)": { color: "red" } }
    });
    expect(received).toEqual([red, blue, red, blue, red]);
    expect(received[1]).toBe(blue);
  });

  it("keeps condition-map priority without splitting ordinary resolver data", () => {
    const { css } = defineRules({
      properties: {
        color: (value: string) => value,
        backgroundColor: (value: { base: string; label: string }) => value.base
      }
    });

    expect(
      css.raw({
        color: { base: "red", _hover: "blue" },
        backgroundColor: { base: "green", label: "ordinary data" }
      })
    ).toEqual({
      color: "red",
      backgroundColor: "green",
      selectors: { "&:hover": { color: "blue" } }
    });
  });

  it("resolves mapped tokens at every pseudo and responsive leaf", () => {
    const { css } = defineRules({
      properties: { backgroundColor: { primary: "blue", strong: "navy" } },
      conditions: { wide: "(min-width: 48em)" },
      shortcuts: { bg: "backgroundColor" }
    });

    expect(
      css.raw({ bg: { base: "primary", _hover: { _wide: "strong" } } })
    ).toEqual({
      backgroundColor: "blue",
      "@media": {
        "(min-width: 48em)": {
          selectors: { "&:hover": { backgroundColor: "navy" } }
        }
      }
    });
    expect(
      css.raw({
        bg: {
          __before: "primary",
          _firstOfType: "strong",
          __WebkitScrollbarThumb: "strong"
        }
      })
    ).toEqual({
      selectors: {
        "&::before": { backgroundColor: "blue" },
        "&:first-of-type": { backgroundColor: "navy" },
        "&::-webkit-scrollbar-thumb": { backgroundColor: "navy" }
      }
    });

    const invalid = () => {
      // @ts-expect-error Conditional leaves retain their token vocabulary.
      css({ bg: { _hover: "missing" } });
    };
    void invalid;
  });

  it("resolves native at-rule and selector groups before lowering conditions", () => {
    const length = (value: number) => `${value * 4}px`;
    const { css } = defineRules({
      properties: {
        color: { primary: "blue", strong: "navy" },
        paddingLeft: length,
        paddingRight: length
      },
      shortcuts: { text: "color", px: ["paddingLeft", "paddingRight"] }
    });

    expect(
      css.raw({
        text: {
          base: "primary",
          "@media (min-width: 40rem)": "strong",
          "@supports": { "(display: grid)": "strong" },
          selectors: { '&[aria-current="page"]': "strong" }
        }
      })
    ).toEqual({
      color: "blue",
      "@media": { "(min-width: 40rem)": { color: "navy" } },
      "@supports": { "(display: grid)": { color: "navy" } },
      selectors: { '&[aria-current="page"]': { color: "navy" } }
    });

    expect(
      css.raw({
        px: {
          "@media": {
            "(min-width: 40rem)": { "@supports (display: grid)": 2 }
          }
        }
      })
    ).toEqual({
      "@supports": {
        "(display: grid)": {
          "@media": {
            "(min-width: 40rem)": {
              paddingLeft: "8px",
              paddingRight: "8px"
            }
          }
        }
      }
    });

    const invalid = () => {
      // @ts-expect-error Native at-rule leaves retain their token vocabulary.
      css({ text: { "@media (min-width: 40rem)": "missing" } });
      // @ts-expect-error Grouped at-rule leaves retain the resolver input type.
      css({ px: { "@supports": { "(display: grid)": "small" } } });
    };
    void invalid;
  });

  it("preserves unregistered underscore keys in resolver arguments", () => {
    type Channels = { _channels: number[] };

    const { css } = defineRules({
      properties: {
        color: ({ _channels }: Channels) => `rgb(${_channels.join(" ")})`,
        opacity: true
      },
      shortcuts: {
        text: "color",
        channelOpacity: ({ _channels }: Channels) => ({
          opacity: _channels[0]! / 255
        })
      },
      conditions: {
        wide: "(min-width: 48rem)"
      }
    });
    const red = { _channels: [255, 0, 0] };
    const blue = { _channels: [0, 0, 255] };

    expect(css.raw({ color: red })).toEqual({ color: "rgb(255 0 0)" });
    expect(css.raw({ text: { _hover: red, _wide: blue } })).toEqual({
      selectors: { "&:hover": { color: "rgb(255 0 0)" } },
      "@media": { "(min-width: 48rem)": { color: "rgb(0 0 255)" } }
    });
    expect(
      css.raw({ channelOpacity: { base: red, _focusVisible: blue } })
    ).toEqual({
      opacity: 1,
      selectors: { "&:focus-visible": { opacity: 0 } }
    });
  });

  it("runs value resolvers and shortcut chains before atomic composition", () => {
    const length = (value: number) => `${value * 4}px`;
    const { css, cx } = defineRules({
      properties: {
        paddingLeft: length,
        paddingRight: length,
        paddingTop: length,
        paddingBottom: length
      },
      conditions: { wide: "(min-width: 48em)" },
      shortcuts: {
        p: ["px", "py"],
        px: ["pl", "pr"],
        py: ["pt", "pb"],
        pl: "paddingLeft",
        pr: "paddingRight",
        pt: "paddingTop",
        pb: "paddingBottom"
      }
    });

    const initial = css({ p: { base: 4, _hover: 2, _wide: 6 } });
    const override = css({ px: 3, pl: { base: 1, _hover: 0 } });
    const expected = css({
      pt: 4,
      pb: 4,
      pr: 3,
      pl: 1,
      _hover: { pt: 2, pb: 2, pr: 2, pl: 0 },
      _wide: { p: 6 }
    });
    const atoms = (className: string) =>
      className
        .split(/\s+/)
        .filter((name) => !name.startsWith("__mincho_seg_"))
        .sort();

    expect(atoms(cx(initial, override))).toEqual(atoms(expected));
    expect(css.raw({ p: 4, px: 3, pl: 1 })).toEqual({
      paddingLeft: "4px",
      paddingRight: "12px",
      paddingTop: "16px",
      paddingBottom: "16px"
    });
  });
});
