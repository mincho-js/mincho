import { parseSync, traverse, type NodePath } from "@babel/core";
import { describe, it, expect, vi } from "vitest";
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
  it.each([
    'getComputedStyle(el)["animation-name"]',
    'getComputedStyle(el)["font-family"]',
    'element.style["animation-name"] = value',
    'element.style["font-family"] = value',
    'style?.["animation-name"]',
    'style?.["font-family"]',
    'const {"animation-name": name} = style',
    'const {"font-family": name} = style'
  ])("observes dashed CSSOM resource access: %s", (code) => {
    expect(analyzeCssObservability(code).whole).toBe(true);
  });

  it.each([
    {
      code: 'element.style["animation-name"] = "privateAnim"',
      name: "privateAnim"
    },
    {
      code: 'element.style["font-family"] = "privateFont"',
      name: "privateFont"
    }
  ])("pins literal resource names for $code", ({ code, name }) => {
    expect(analyzeCssObservability(code)).toMatchObject({
      whole: false,
      names: [name]
    });
  });

  it("keeps custom property spelling and unrelated dashed observations scoped", () => {
    expect(analyzeCssObservability('style["--font-family"]')).toMatchObject({
      whole: false,
      names: []
    });
    expect(
      analyzeCssObservability('style.getPropertyValue("--font-family")')
    ).toMatchObject({ whole: false, variables: ["--font-family"] });
    expect(
      analyzeCssObservability('getComputedStyle(el)["background-color"]')
    ).toMatchObject({ whole: false });
  });

  it.each<[string, string, boolean]>([
    ["sheet.insertRule(rule)", "sheet?.insertRule(rule)", true],
    ["sheet.insertRule(rule)", "sheet.insertRule?.(rule)", true],
    ["sheet.insertRule(rule)", "sheet?.insertRule?.(rule)", true],
    ["sheet.deleteRule(index)", "sheet?.deleteRule(index)", true],
    ["sheet.replaceSync(text)", "sheet?.replaceSync(text)", true],
    ["CSS.registerProperty(config)", "CSS?.registerProperty(config)", true],
    ["el.computedStyleMap()", "el?.computedStyleMap()", true],
    [
      'el.setAttribute("style", value)',
      'el?.setAttribute("style", value)',
      true
    ],
    [
      'el.setAttributeNS(null, "style", value)',
      'el.setAttributeNS?.(null, "style", value)',
      true
    ],
    ["document.fonts", "document?.fonts", true],
    ["document.adoptedStyleSheets", "document?.adoptedStyleSheets", true],
    ["sheet.rules", "sheet?.rules", true],
    ["CSS[method](value)", "CSS?.[method](value)", true],
    ["el.style[property]", "el?.style[property]", true],
    [
      'el.addEventListener("animationend", callback)',
      'el?.addEventListener("animationend", callback)',
      true
    ],
    ["el.style.color", "el?.style.color", false],
    ["el.style.color", "el.style?.color", false],
    ["getComputedStyle(el).color", "getComputedStyle?.(el).color", false],
    ["getComputedStyle(el).color", "getComputedStyle(el)?.color", false],
    [
      'el.style.getPropertyValue("--x")',
      'el.style?.getPropertyValue("--x")',
      false
    ],
    [
      'el.style.getPropertyValue("--x")',
      'el.style.getPropertyValue?.("--x")',
      false
    ],
    [
      'el.style.setProperty("--x", "red")',
      'el.style?.setProperty?.("--x", "red")',
      false
    ],
    [
      'el.addEventListener("click", callback)',
      'el?.addEventListener("click", callback)',
      false
    ],
    [
      'el.setAttribute("title", value)',
      'el?.setAttribute("title", value)',
      false
    ]
  ])(
    "matches optional CSSOM observation for %s and %s",
    (regular, optional, whole) => {
      const expected = analyzeCssObservability(regular);
      expect(expected.whole).toBe(whole);
      expect(analyzeCssObservability(optional)).toEqual(expected);
    }
  );

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

  it.each(
    [
      {
        first: 'first({size:"small"});',
        second: 'second({size:"large"});',
        used: ["base", "large", "small"]
      },
      {
        first: 'first({size:"small"});',
        second: "second(selection);",
        used: null
      },
      {
        first: "",
        second: 'second({size:"large"});',
        used: ["base", "large"]
      },
      { first: "", second: "", used: [] }
    ].flatMap((row) => [false, true].map((reverse) => ({ ...row, reverse })))
  )("merges duplicate recipe IDs: %j", ({ first, second, used, reverse }) => {
    const modules = [
      { id: "/first", code: recipe, imports: new Map() },
      { id: "/second", code: recipe, imports: new Map() }
    ];
    if (reverse) modules.reverse();
    const result = analyzeClosedAppUsage(
      [
        ...modules,
        {
          id: "/app",
          code: `import {button as first} from "./first"; import {button as second} from "./second"; ${first} ${second}`,
          imports: new Map([
            ["./first", "/first"],
            ["./second", "/second"]
          ]),
          entry: true
        }
      ],
      { mode: "closed" }
    );
    expect(result).toMatchObject({
      opaque: false,
      recipes: [{ id: "base", used }]
    });
    expect(result.recipes).toHaveLength(1);
  });

  it.each([
    {
      name: "imported class strings",
      declaration: 'export const cls = "base small";',
      consumer: 'import {cls} from "./classes"; globalThis.result = cls;',
      used: ["base", "small"]
    },
    {
      name: "reexported class strings",
      declaration: 'export const cls = "base small";',
      consumer: 'export {cls} from "./classes";',
      used: ["base", "small"]
    },
    {
      name: "nested class strings",
      declaration: 'export const cls = {button: ["base", "small"]};',
      consumer: 'import {cls} from "./classes"; globalThis.result = cls;',
      used: ["base", "small"]
    },
    {
      name: "unused class strings",
      declaration: 'export const cls = "base small";',
      consumer: 'import "./classes";',
      used: []
    },
    {
      name: "function-local class strings",
      declaration: "",
      consumer:
        'globalThis.render = () => {const cls = "base small"; return cls;};',
      used: ["base", "small"]
    },
    {
      name: "block-local class strings",
      declaration: "",
      consumer: '{const cls = "base small"; globalThis.result = cls;}',
      used: ["base", "small"]
    },
    {
      name: "function-local template class strings",
      declaration: "",
      consumer:
        'globalThis.render = () => {const cls = `base ${"small"}`; return cls;};',
      used: ["base", "small"]
    },
    {
      name: "unused template class strings",
      declaration: 'export const cls = `base ${"small"}`;',
      consumer: 'import "./classes";',
      used: []
    },
    {
      name: "dynamic template class strings",
      declaration: "",
      consumer: "globalThis.render = value => `base ${value} small`;",
      used: ["base", "small"]
    },
    {
      name: "imported dynamic template class strings",
      declaration: "export const cls = `base small ${globalThis.extra}`;",
      consumer: 'import {cls} from "./classes"; globalThis.result = cls;',
      used: ["base", "small"]
    },
    {
      name: "function-local dynamic template class strings",
      declaration: "",
      consumer:
        "globalThis.render = value => {const cls = `base small ${value}`; return cls;};",
      used: ["base", "small"]
    },
    {
      name: "escaped dynamic template class strings",
      declaration: "",
      consumer:
        "globalThis.render = value => `ba\\u0073e sm\\u0061ll ${value}`;",
      used: ["base", "small"]
    },
    {
      name: "raw tagged template class strings",
      declaration: "",
      consumer:
        "globalThis.render = value => tag`base small ${value} \\u{invalid}`;",
      used: ["base", "small"]
    },
    {
      name: "conditional template class strings",
      declaration: "",
      consumer:
        'globalThis.render = value => `base ${value ? "small" : "large"}`;',
      used: ["base", "large", "small"]
    },
    {
      name: "mutable class strings",
      declaration: "",
      consumer:
        'let cls = "base small"; globalThis.reset = () => {cls = "base large";}; globalThis.render = () => cls;',
      used: ["base", "large", "small"]
    }
  ])(
    "tracks $name without retaining unused variants",
    ({ declaration, consumer, used }) => {
      const result = analyzeClosedAppUsage(
        [
          { id: "/recipe", code: recipe, imports: new Map() },
          { id: "/classes", code: declaration, imports: new Map() },
          {
            id: "/app",
            code: consumer,
            imports: new Map([["./classes", "/classes"]]),
            entry: true
          }
        ],
        { mode: "closed" }
      );
      expect(result).toMatchObject({
        opaque: false,
        recipes: [{ id: "base", used }]
      });
    }
  );

  it.each([
    { code: 'require("./recipe");', opaque: true },
    { code: 'const load = require; load("./recipe");', opaque: true },
    { code: 'module.require("./recipe");', opaque: true },
    { code: 'module["require"]("./recipe");', opaque: true },
    { code: 'module?.require?.("./recipe");', opaque: true },
    {
      code: 'const loader = module; loader.require("./recipe");',
      opaque: true
    },
    {
      code: 'const {require: load} = module; load("./recipe");',
      opaque: true
    },
    {
      code: 'function use(require) {const load = require; load("./recipe");}',
      opaque: false
    },
    {
      code: 'function use(module) {module.require("./recipe");}',
      opaque: false
    },
    {
      code: 'function use(module) {module["require"]("./recipe");}',
      opaque: false
    }
  ])("handles CommonJS graph barriers in $code", ({ code, opaque }) => {
    const result = analyzeClosedAppUsage(
      [
        { id: "/recipe", code: recipe, imports: new Map() },
        { id: "/app", code, imports: new Map(), entry: true }
      ],
      { mode: "closed" }
    );
    expect(result).toMatchObject({
      opaque,
      recipes: [{ id: "base", used: opaque ? null : [] }]
    });
  });

  it.each([true, false])(
    "evaluates large literal tables once when confidence is %s",
    (confident) => {
      const tokens = Array.from(
        { length: 200 },
        (_, index) => `--token-${index}`
      );
      const entries = tokens
        .map((token, index) => `key${index}: ${JSON.stringify(token)}`)
        .join(",");
      let pathPrototype: NodePath | undefined;
      traverse(parseSync("0;", { babelrc: false, configFile: false })!, {
        Program(path) {
          pathPrototype = Object.getPrototypeOf(path) as NodePath;
          path.stop();
        }
      });
      expect(pathPrototype).toBeDefined();
      const evaluate = vi.spyOn(pathPrototype!, "evaluate");
      try {
        const result = analyzeClosedAppUsage(
          [
            {
              id: "/app",
              code: `const table = {${entries}${confident ? "" : ", unknown"}};`,
              imports: new Map(),
              entry: true
            }
          ],
          { mode: "closed" }
        );
        const initializers = evaluate.mock.contexts.filter((context) => {
          const path = context as NodePath;
          return (
            path.isObjectExpression() && path.parentPath?.isVariableDeclarator()
          );
        });
        expect(initializers).toHaveLength(1);
        expect(result).toMatchObject({
          opaque: false,
          variableReferences: confident ? [] : [...tokens].sort()
        });
      } finally {
        evaluate.mockRestore();
      }
    }
  );

  it.each([3, 130])(
    "handles %i program-scope aliases without losing recipe classes",
    (count) => {
      const aliases = Array.from(
        { length: count },
        (_, index) =>
          `const alias${index} = ${index ? `alias${index - 1}` : "button"};`
      ).join("\n");
      const result = analyzeClosedAppUsage(
        [
          { id: "/recipe", code: recipe, imports: new Map() },
          {
            id: "/app",
            code: `import {button} from "./recipe"; ${aliases} globalThis.result = alias${count - 1}({size:"large"});`,
            imports: new Map([["./recipe", "/recipe"]]),
            entry: true
          }
        ],
        { mode: "closed" }
      );
      expect(result).toMatchObject({
        opaque: count === 130,
        recipes: [
          { id: "base", used: count === 130 ? null : ["base", "large"] }
        ]
      });
    }
  );

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
