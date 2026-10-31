import { describe, it, expect } from "vitest";
import { analyzeCssObservability } from "./cssObservability.js";
import { analyzeClosedAppUsage } from "./closedAppUsage.js";
import {
  measureRuntimeCandidate,
  preferRuntimeCandidate
} from "./bundleSize.js";
const config = {
  defaultClassName: "base",
  variantClassNames: {
    size: {
      small: "small",
      large: "large"
    }
  },
  defaultVariants: {
    size: "small"
  },
  compoundVariants: []
};
const recipe = `import {createCompiledClassRuntimeFn} from '@mincho-js/css/rules/createClassRuntimeFn'; export const button=createCompiledClassRuntimeFn(${JSON.stringify(config)});`;
describe("bundle-size safety and costs", () => {
  it("scopes literal property observations and pins unknown CSSOM operations", () => {
    expect(
      analyzeCssObservability(
        'getComputedStyle(el).getPropertyValue("--observed")'
      )
    ).toMatchObject({
      whole: false,
      variables: ["--observed"]
    });
    expect(analyzeCssObservability("getComputedStyle(el).color")).toMatchObject(
      {
        whole: false
      }
    );
    for (const code of [
      "getComputedStyle(el)",
      "getComputedStyle(el).getPropertyValue(name)",
      "document.styleSheets",
      "const read=style.getPropertyValue",
      "const read=window.getComputedStyle;inspect(read)",
      "const style=element.style;inspect(style)",
      "const {style}=element;inspect(style)",
      "element.style.animationName=name",
      'element.setAttribute("style",cssText)',
      "const {animationName:name}=event;inspect(name)",
      "event?.animationName",
      "element.getAnimations().map(inspect)",
      'element.addEventListener("animationend",inspect)',
      "const props={onAnimationEnd:inspect}",
      "const {getAnimations:read}=element;inspect(read)",
      "const listen=element.addEventListener;listen(type,inspect)",
      "getComputedStyle(el).animationName",
      'style.setProperty("--x", value)'
    ])
      expect(analyzeCssObservability(code).whole).toBe(true);
    expect(
      analyzeCssObservability('element.style.animationName="privateAnim"')
    ).toMatchObject({
      whole: false,
      names: ["privateAnim"]
    });
  });
  it("charges actual compact helper dependencies and preserves ties", async () => {
    const after = recipe
      .replaceAll("createCompiledClassRuntimeFn", "createCompactClassRuntimeFn")
      .replace("/createClassRuntimeFn", "/createCompactRuntimeFn");
    const result = await preferRuntimeCandidate(
      recipe,
      after,
      process.cwd() + "/fixture.ts"
    );
    expect(result.applied).toBe(true);
    expect(result.candidate.brotli).toBeLessThan(result.original.brotli);
    expect(
      (
        await preferRuntimeCandidate(
          recipe,
          recipe,
          process.cwd() + "/fixture.ts"
        )
      ).applied
    ).toBe(false);
    expect(
      (await measureRuntimeCandidate(after, process.cwd() + "/fixture.ts")).raw
    ).toBeGreaterThan(after.length);
  });
  it("follows internal exports, pins escapes and honors export preservation", () => {
    const modules = [
      {
        id: "/recipe",
        code: recipe,
        imports: new Map()
      },
      {
        id: "/app",
        code: 'import {button} from "./recipe"; globalThis.result=button({size:"small"})',
        imports: new Map([["./recipe", "/recipe"]]),
        entry: true
      }
    ];
    expect(
      analyzeClosedAppUsage(modules, {
        mode: "closed"
      })
    ).toMatchObject({
      opaque: false,
      recipes: [
        {
          id: "base",
          used: ["base", "small"]
        }
      ]
    });
    expect(
      analyzeClosedAppUsage(modules, {
        mode: "closed",
        preserve: [
          {
            module: "/recipe",
            exports: ["button"]
          }
        ]
      }).recipes[0]!.used
    ).toBeNull();
    const unknown = [
      ...modules.slice(0, 1),
      {
        ...modules[1]!,
        code: 'import {button} from "./recipe"; globalThis.recipe=button'
      }
    ];
    expect(
      analyzeClosedAppUsage(unknown, {
        mode: "closed"
      }).recipes[0]!.used
    ).toBeNull();
    expect(
      analyzeClosedAppUsage(
        [
          ...modules,
          {
            id: "/dynamic",
            imports: new Map(),
            code: "import(path)"
          }
        ],
        {
          mode: "closed"
        }
      ).opaque
    ).toBe(true);
  });
  it("keeps selected classes through compact factories and internal reexports", () => {
    const compact = recipe
      .replaceAll("createCompiledClassRuntimeFn", "createCompactClassRuntimeFn")
      .replace("/createClassRuntimeFn", "/createCompactRuntimeFn");
    const result = analyzeClosedAppUsage(
      [
        {
          id: "/recipe",
          code: compact,
          imports: new Map()
        },
        {
          id: "/bridge",
          code: 'export {button as alias} from "./recipe"',
          imports: new Map([["./recipe", "/recipe"]])
        },
        {
          id: "/app",
          code: 'import {alias} from "./bridge";globalThis.result=alias({size:"large"})',
          imports: new Map([["./bridge", "/bridge"]]),
          entry: true
        }
      ],
      {
        mode: "closed"
      }
    );
    expect(result).toMatchObject({
      opaque: false,
      recipes: [
        {
          id: "base",
          used: ["base", "large"]
        }
      ]
    });
  });

  it("follows a default import of a named recipe export", () => {
    const result = analyzeClosedAppUsage(
      [
        {
          id: "/recipe",
          code: `${recipe.replace("export const", "const")} export {button as default};`,
          imports: new Map()
        },
        {
          id: "/app",
          code: 'import button from "./recipe"; globalThis.result=button({size:"large"})',
          imports: new Map([["./recipe", "/recipe"]]),
          entry: true
        }
      ],
      { mode: "closed" }
    );
    expect(result).toMatchObject({
      opaque: false,
      recipes: [{ id: "base", used: ["base", "large"] }]
    });
  });

  it.each([
    {
      name: "a default-exported recipe",
      declaration: "export default RECIPE;",
      consumer: 'import button from "./recipe"; button({size:"large"})'
    },
    {
      name: "a recipe nested in an object",
      declaration: "export const ui = {button: RECIPE};",
      consumer: 'import {ui} from "./recipe"; ui.button({size:"large"})'
    },
    {
      name: "a function-local recipe",
      declaration:
        "export function createButton() { const button = RECIPE; return button; }",
      consumer:
        'import {createButton} from "./recipe"; createButton()({size:"large"})'
    },
    {
      name: "a mutable recipe binding",
      declaration:
        "export let button = RECIPE; export function replaceButton(value) { button = value; }",
      consumer: 'import {button} from "./recipe"; button({size:"large"})'
    },
    {
      name: "a function-local alias",
      declaration: "export const button = RECIPE;",
      consumer:
        'import {button} from "./recipe"; function App() { const b = button; return b({size:"large"}); }'
    },
    {
      name: "a block-local alias",
      declaration: "export const button = RECIPE;",
      consumer:
        'import {button} from "./recipe"; { const b = button; globalThis.result = b({size:"large"}); }'
    }
  ])("preserves every class for $name", ({ declaration, consumer }) => {
    const result = analyzeClosedAppUsage(
      [
        {
          id: "/recipe",
          code: `import {createCompiledClassRuntimeFn} from '@mincho-js/css/rules/createClassRuntimeFn'; ${declaration.replace("RECIPE", `createCompiledClassRuntimeFn(${JSON.stringify(config)})`)}`,
          imports: new Map()
        },
        {
          id: "/app",
          code: consumer,
          imports: new Map([["./recipe", "/recipe"]]),
          entry: true
        }
      ],
      { mode: "closed" }
    );
    expect(result).toMatchObject({
      opaque: false,
      recipes: [{ id: "base", used: null }]
    });
  });

  it("preserves recipe classes through a dynamically imported namespace reexport", () => {
    const result = analyzeClosedAppUsage(
      [
        { id: "/recipe", code: recipe, imports: new Map() },
        {
          id: "/bridge",
          code: 'export * as ns from "./recipe"',
          imports: new Map([["./recipe", "/recipe"]])
        },
        {
          id: "/app",
          code: 'import("./bridge").then((module) => module.ns.button({size:"large"}))',
          imports: new Map([["./bridge", "/bridge"]]),
          entry: true
        }
      ],
      { mode: "closed" }
    );
    expect(result).toMatchObject({
      opaque: true,
      recipes: [{ id: "base", used: null }]
    });
  });
});
