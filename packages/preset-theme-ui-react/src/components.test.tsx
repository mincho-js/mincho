import { defineRules } from "@mincho-js/css";
import {
  dark as darkDefinition,
  system as systemDefinition,
  systemVars
} from "@mincho-js/preset-theme-ui";
import { darkPreset, systemPreset } from "@mincho-js/preset-theme-ui/presets";
import type { Adapter } from "@vanilla-extract/css";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { $$styled } from "@mincho-js/react/runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileComponents, createComponents } from "./components.js";
import { system } from "./index.js";

type CssEntry = Parameters<Adapter["appendCss"]>[0];

function isGlobalRule(
  entry: CssEntry
): entry is CssEntry & { selector: string; rule: object } {
  return entry.type === "global" && "selector" in entry && "rule" in entry;
}

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
  return defineRules({
    properties: {
      color: {
        primary: "#111199",
        secondary: "#996600",
        text: "#171717",
        background: "#ffffff"
      },
      backgroundColor: { primary: "#111199", secondary: "#996600" },
      fontSize: { 2: 16, 3: 20 },
      fontWeight: { body: 400, heading: 700, display: 900 },
      paddingLeft: { 2: 8, 3: 16, 4: 32 },
      paddingRight: { 2: 8, 3: 16, 4: 32 }
    },
    shortcuts: { bg: "backgroundColor", px: ["paddingLeft", "paddingRight"] },
    conditions: { sm: { "@media": "(min-width: 40em)" } }
  });
}

describe("Theme UI component factories", () => {
  const emitted: CssEntry[] = [];

  beforeEach(() => {
    emitted.length = 0;
    setAdapter({ ...mockAdapter, appendCss: (entry) => emitted.push(entry) });
    setFileScope("theme-ui-components.css.ts", "@test/theme-ui-react");
  });

  afterEach(() => {
    endFileScope();
    removeAdapter();
  });

  it("preserves a live preset getter and does not compile components when binding", () => {
    expect(Object.getOwnPropertyDescriptor(system, "preset")?.get).toBeTypeOf(
      "function"
    );
    expect(emitted).toHaveLength(0);

    const initial = system.preset;
    system.css({ color: "primary" });
    expect(system.preset).toBe(systemDefinition.preset);
    expect(system.preset).not.toBe(initial);
    expect(JSON.stringify(emitted)).not.toContain("mincho-theme-ui-");
  });

  it("compiles semantic variants and retains element props without forwarding variant", () => {
    const { Button, Heading } = createComponents(definition(), {
      buttons: {
        primary: { color: "background", bg: "primary" },
        secondary: { variant: "buttons.primary", bg: "secondary" }
      },
      text: {
        display: { fontSize: { base: 2, _sm: 3 }, fontWeight: "display" }
      }
    });
    const RuntimeButton = materialize(Button);
    const RuntimeHeading = materialize(Heading);
    const html = renderToStaticMarkup(
      <>
        <RuntimeButton variant="secondary" type="submit">
          Save
        </RuntimeButton>
        <RuntimeHeading variant="display" as="h1">
          Title
        </RuntimeHeading>
      </>
    );

    expect(html).toContain("<button");
    expect(html).toContain('type="submit"');
    expect(html).toContain("<h1");
    expect(html).not.toContain("variant=");
    expect(JSON.stringify(emitted)).toContain('"backgroundColor":"#996600"');
    expect(JSON.stringify(emitted)).toContain('"color":"#ffffff"');
    expect(JSON.stringify(emitted)).toContain("(min-width: 40em)");
  });

  it("resolves a component group before a root fallback and keeps inheritance order", () => {
    compileComponents(
      definition(),
      {},
      {
        primary: { color: "secondary" },
        buttons: { primary: { color: "primary" } },
        text: {
          inherited: { color: "text", fontWeight: "heading" },
          before: { color: "secondary", variant: "text.inherited" },
          after: { variant: "text.inherited", color: "secondary" }
        }
      }
    );

    const css = JSON.stringify(emitted);
    expect(css).toContain('"color":"#111199"');
    expect(css).toContain('"color":"#171717","fontWeight":700');
    expect(css).toContain('"color":"#996600","fontWeight":700');
  });

  it("preserves stock fields while merging overrides and lowers stock responsive values", () => {
    compileComponents(
      systemDefinition,
      { text: { display: { color: "primary" } } },
      systemPreset
    );
    const css = JSON.stringify(emitted);

    expect(css).toContain(systemVars.fontWeights.display);
    expect(css).toContain(systemVars.fonts.heading);
    expect(css).toContain(systemVars.fontSizes[5]);
    expect(css).toContain(systemVars.fontSizes[6]);
    expect(css).toContain("min-width: 40em");
    expect(css).toContain('"fontWeight":');
    expect(css).toContain('"fontFamily":');
    expect(css).not.toContain('"variant":');
    expect(css).not.toContain('"fontSize":[5,6]');
  });

  it("resolves dark prism inheritance and scopes comma and nested selectors with tokens", () => {
    compileComponents(darkDefinition, {}, darkPreset);
    const globals = emitted.filter(isGlobalRule);
    const css = JSON.stringify(globals);

    expect(css).toContain(".comment");
    expect(css).toContain(".prolog");
    expect(css).toContain(" code");
    expect(css).toContain(" th");
    expect(css).toContain(" td");
    expect(css).toContain(":hover");
    expect(css).not.toMatch(/"color":"(?:primary|secondary|gray|purple)"/);
    expect(css).not.toContain('"variant":');
    for (const entry of globals) {
      expect(
        entry.selector
          .split(",")
          .every((selector) =>
            selector.trim().startsWith(".theme-ui-components")
          )
      ).toBe(true);
    }
  });

  it("shares compiled variant CSS across primitives and layers it below explicit native css", () => {
    const core = definition();
    // Generate explicit user CSS first, so precedence cannot depend on source order.
    core.css({ px: 4, bg: "secondary" });
    const { Button, Heading } = createComponents(core, {
      text: { display: { color: "primary", fontWeight: "display" } }
    });
    const RuntimeButton = materialize(Button);
    const RuntimeHeading = materialize(Heading);
    const button = renderToStaticMarkup(
      <RuntimeButton variant="text.display" />
    );
    const heading = renderToStaticMarkup(
      <RuntimeHeading variant="text.display" />
    );
    const buttonClasses = /class="([^"]+)"/.exec(button)![1].split(" ");
    const headingClasses = /class="([^"]+)"/.exec(heading)![1].split(" ");

    expect(
      buttonClasses.some((value) => value && headingClasses.includes(value))
    ).toBe(true);
    const globals = emitted.filter(isGlobalRule);
    expect(
      globals.filter((entry) =>
        JSON.stringify(entry.rule).includes('"fontWeight":900')
      )
    ).toHaveLength(1);
    expect(globals.every((entry) => "@layer" in entry.rule)).toBe(true);
  });

  it.each([
    { text: { display: { variant: "text.missing" } } },
    {
      text: {
        first: { variant: "text.second" },
        second: { variant: "text.first" }
      }
    }
  ])("rejects unresolved or cyclic inheritance", (groups) => {
    expect(() => compileComponents(definition(), groups)).toThrow(
      /Unknown|Circular/
    );
  });

  it("requires native condition objects for user groups", () => {
    expect(() =>
      compileComponents(definition(), {
        text: { display: { fontSize: [2, 3] } }
      })
    ).toThrow(/condition objects/);
  });
});
