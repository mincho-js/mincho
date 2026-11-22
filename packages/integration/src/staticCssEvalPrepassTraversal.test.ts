import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { internalStaticCssEvalLimits } from "@mincho-js/babel";
import { babelTransformSource } from "./babel.js";
import {
  createStaticCssEvalPrepass,
  STATIC_CSS_EVAL_EXECUTION_LIMITS,
  STATIC_CSS_EVAL_PREPASS_MAX_TRAVERSED_NODES
} from "./staticCssEvalPrepass.js";

import { createLoadedModule } from "./staticCssEvalPrepassSource.js";

it("preserves provider syntax selection without discarding resolver metadata", () => {
  const id = "/src/tokens.ts?variant=dark";
  const resolvedFile = "/src/tokens.data";
  const source = 'export const color: string = "red";';
  const resolution = {
    resolvedFile,
    canonicalModuleId: id,
    normalizedPathKey: id,
    resolverKind: "test",
    realpath: resolvedFile,
    sourceKind: "provider-virtual",
    sourceOrigin: "provider"
  } as const;
  expect(createLoadedModule(id, { source }, { resolution })).toMatchObject({
    id,
    resolvedFile,
    realpath: resolvedFile,
    syntaxSourceId: id,
    source
  });
  const opaqueId = "tokens:theme";
  const resolverFilename = "/src/tokens.ts";
  expect(
    createLoadedModule(
      opaqueId,
      { source },
      {
        resolution: {
          ...resolution,
          realpath: undefined,
          resolvedFile: resolverFilename,
          normalizedPathKey: opaqueId
        }
      }
    )
  ).toMatchObject({ id: opaqueId, resolvedFile: resolverFilename });
  expect(
    createLoadedModule(opaqueId, { source }, { resolution })
  ).not.toHaveProperty("syntaxSourceId");

  const loaderPath = "/src/loader.ts";
  expect(
    createLoadedModule(id, { source, resolvedFile: loaderPath }, { resolution })
  ).toMatchObject({ resolvedFile: loaderPath, syntaxSourceId: loaderPath });
  const physicalPath = "/src/loader#.ts";
  const physical = createLoadedModule(
    id,
    { source, realpath: physicalPath, sourceKind: "project-source" },
    { resolution }
  );
  expect(physical.realpath).toBe(physicalPath);
  expect(physical).not.toHaveProperty("syntaxSourceId");
  expect(
    createLoadedModule(id, { source, realpath: physicalPath }, { resolution })
  ).toMatchObject({ realpath: physicalPath, syntaxSourceId: id });
});

it.each([
  ["virtual:tokens", false, "/cache/tokens.data"],
  ["virtual:tokens", true, "/cache/tokens.data"],
  ["/src/theme#dark.ts", false, "/cache/tokens.data"],
  ["/src/theme.ts?variant=dark", false, "/cache/tokens.data"],
  ["/src/theme.tsx?theme=/dark.js#preview", false, "/cache/tokens.data"],
  ["/src/loader-overrides.js", true, "/cache/archive.js#tokens.ts"]
] as const)(
  "evaluates TypeScript for graph ID %s (loader evidence %s, backing path %s)",
  async (moduleId, loaderPath, realpath) => {
    const ownerId = "/owner.tsx";
    const owner = 'import {rule} from "tokens"; <div css={rule} />;';
    const expressionStart = owner.lastIndexOf("rule");
    const result = await createStaticCssEvalPrepass(ownerId, {
      resolve: (_importer, specifier) =>
        specifier === "tokens"
          ? {
              resolvedFile: moduleId,
              ...(loaderPath ? {} : { realpath })
            }
          : null,
      load: (id) =>
        id === ownerId
          ? { source: owner }
          : id === moduleId
            ? {
                source:
                  'export const rule: {color: string} = {color: "tomato"};',
                ...(loaderPath ? { realpath } : {})
              }
            : null
    });
    expect(
      result.provider.getResolvedCssValue({
        importerId: ownerId,
        expressionStart,
        expressionEnd: expressionStart + "rule".length,
        bindingName: "rule"
      })
    ).toMatchObject({ kind: "resolved", value: { color: "tomato" } });
    expect(result.result.resolvedModuleCache.get(moduleId)).toMatchObject({
      id: moduleId,
      realpath
    });
  }
);

it.each([
  [
    "/src/archive.ts#old/tokens.tsx",
    "/src/archive.ts#old/tokens.tsx",
    undefined
  ],
  ["/src/archive.ts#old/tokens.tsx", undefined, undefined],
  ["/tokens.tsx?theme=/dark.js#preview", undefined, undefined],
  [
    "/tokens.tsx?theme=/dark.js#preview.tsx",
    "/tokens.tsx?theme=/dark.js#preview.tsx",
    "project-source"
  ],
  [
    "/tokens.tsx?theme=/dark.js#preview",
    "/tokens.tsx?theme=/dark.js#preview",
    "provider-virtual"
  ]
] as const)(
  "preserves JSX syntax for %s without requiring physical metadata",
  async (moduleId, loaderFilename, sourceKind) => {
    const ownerId = "/owner.tsx";
    const owner = 'import {rule} from "tokens"; <div css={rule} />;';
    const expressionStart = owner.lastIndexOf("rule");
    const result = await createStaticCssEvalPrepass(ownerId, {
      resolve: (_importer, specifier) =>
        specifier === "tokens" ? { resolvedFile: moduleId } : null,
      load: (id) =>
        id === ownerId
          ? { source: owner }
          : id === moduleId
            ? {
                source:
                  'export function View() { return <span />; } export const rule: {color: string} = {color: "tomato"};',
                ...(loaderFilename ? { resolvedFile: loaderFilename } : {}),
                ...(sourceKind ? { sourceKind } : {})
              }
            : null
    });

    expect(
      result.provider.getResolvedCssValue({
        importerId: ownerId,
        expressionStart,
        expressionEnd: expressionStart + "rule".length,
        bindingName: "rule"
      })
    ).toMatchObject({ kind: "resolved", value: { color: "tomato" } });
    expect(result.result.resolvedModuleCache.get(moduleId)).toMatchObject({
      id: moduleId,
      resolvedFile: moduleId
    });
  }
);

it.each([
  [
    "resolver-only literal hash path",
    "/src/theme.js#dark.tsx",
    "/src/theme.js#dark.tsx",
    {}
  ],
  [
    "opaque backing path",
    "/tokens.tsx?theme=/dark.js#preview",
    "/src/backing.data",
    {}
  ],
  [
    "explicit virtual loader filename",
    "virtual:tokens",
    "/src/backing.js",
    { resolvedFile: "/src/generated.tsx", sourceKind: "provider-virtual" }
  ],
  [
    "independent loader name with a differently typed backing path",
    "/src/token.tsx",
    "/src/resolver.js",
    {
      resolvedFile: "/src/generated.tsx",
      realpath: "/src/backing.js",
      sourceKind: "provider-virtual"
    }
  ],
  [
    "declared virtual TSX with JavaScript backing",
    "virtual:tokens.tsx",
    "/cache/tokens.js",
    {
      resolvedFile: "virtual:tokens.tsx",
      realpath: "/cache/tokens.js",
      sourceKind: "provider-virtual"
    }
  ],
  [
    "declared virtual TSX query with JavaScript backing",
    "virtual:tokens.tsx?scope=/dark.js#preview.tsx",
    "/cache/tokens.js",
    { sourceKind: "provider-virtual" }
  ],
  [
    "graph ID echo with actual loader physical path",
    "/src/token.js",
    "/src/resolver.js",
    {
      resolvedFile: "/src/token.js",
      realpath: "/src/actual.tsx",
      sourceKind: "project-source"
    }
  ],
  [
    "opaque virtual ID with TSX physical fallback",
    "virtual:tokens",
    "/cache/tokens.tsx",
    { sourceKind: "provider-virtual" }
  ],
  [
    "loader physical path",
    "/plain.js",
    "/src/resolver.js",
    { realpath: "/src/loader.js#variant.tsx" }
  ]
] as const)(
  "preserves JSX syntax from %s",
  async (_case, id, realpath, load) => {
    const ownerId = "/owner.tsx";
    const owner = 'import {rule} from "tokens"; <div css={rule} />;';
    const expressionStart = owner.lastIndexOf("rule");
    const result = await createStaticCssEvalPrepass(ownerId, {
      resolve: (_importer, specifier) =>
        specifier === "tokens" ? { resolvedFile: id, realpath } : null,
      load: (file) =>
        file === ownerId
          ? { source: owner }
          : file === id
            ? {
                ...load,
                source:
                  'export function View() { return <span />; } export const rule: {color: string} = {color: "tomato"};'
              }
            : null
    });

    expect(
      result.provider.getResolvedCssValue({
        importerId: ownerId,
        expressionStart,
        expressionEnd: expressionStart + "rule".length,
        bindingName: "rule"
      })
    ).toMatchObject({ kind: "resolved", value: { color: "tomato" } });
    expect(result.result.resolvedModuleCache.get(id)).toMatchObject({
      id,
      realpath: "realpath" in load ? load.realpath : realpath
    });
  }
);

const execute = promisify(execFile);

function prepass(modules: Record<string, string>) {
  return createStaticCssEvalPrepass("/owner.tsx", {
    resolve: (_importer, specifier) => ({ id: specifier }),

    load: (id) =>
      modules[id] === undefined ? null : { sourceText: modules[id] }
  });
}

async function expectBoundedPrepass(
  modules: Record<string, string>,
  message: string
) {
  const result = await prepass(modules);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "limit-exceeded",
      message: expect.stringContaining(message)
    })
  ]);
  expect(result.result.resolvedModuleCache.size).toBe(0);
  expect(
    result.provider.getResolvedCssValue({
      importerId: "/owner.tsx",
      expressionStart: 0,
      expressionEnd: 1,
      bindingName: "style"
    })
  ).toEqual({ kind: "not-candidate" });

  const transformed = await babelTransformSource({
    filename: "/owner.tsx",
    source: modules["/owner.tsx"]!,
    babel: {
      jsxCssProp: true,
      staticCssEvalSourceProvider: {
        resolve: (_importer, specifier) => ({ id: specifier }),
        load: (id) =>
          modules[id] === undefined ? null : { sourceText: modules[id] }
      }
    }
  });
  expect(transformed.staticCssEval?.diagnostics).toEqual(result.diagnostics);
  // Later compiler stages may observe additional watch dependencies.
  expect(transformed.staticCssEval?.dependencyFiles).toEqual(
    expect.arrayContaining(result.result.dependencyFiles)
  );
  const fallback = await babelTransformSource({
    filename: "/owner.tsx",
    source: modules["/owner.tsx"]!,
    babel: { jsxCssProp: true }
  });
  expect(transformed.code).toBe(fallback.code);
  expect(transformed.result).toEqual(fallback.result);
}

describe("static CSS prepass traversal", () => {
  it("bounds package execution discovery before loading beyond the module limit", async () => {
    const loaded: string[] = [];
    const result = await createStaticCssEvalPrepass("/owner.tsx", {
      resolve: (_importer, specifier) => ({
        id: specifier,
        sourceKind: specifier.startsWith("/pkg/")
          ? "package-source"
          : "project-source"
      }),
      load(id) {
        loaded.push(id);
        if (id === "/owner.tsx")
          return {
            sourceText:
              'import { style } from "/style.ts"; import "/pkg/0.ts"; <div css={style} />;'
          };
        if (id === "/style.ts")
          return { sourceText: 'export const style = { color: "red" };' };
        const index = Number(id.slice("/pkg/".length, -3));
        return { sourceText: `import "/pkg/${index + 1}.ts";` };
      }
    });
    expect(loaded).toHaveLength(STATIC_CSS_EVAL_EXECUTION_LIMITS.modules);
    expect(result.diagnostics[0]?.code).toBe("limit-exceeded");
    // An uninspected package can mutate this object. Do not reuse a literal
    // resolved before execution discovery as proof that the object is immutable.
    expect(
      result.provider.getResolvedCssValue({
        importerId: "/owner.tsx",
        expressionStart: 0,
        expressionEnd: 1,
        bindingName: "style"
      })
    ).toEqual({ kind: "not-candidate" });
  });

  it("includes package side effects that can mutate already discovered literals", async () => {
    const modules: Record<string, string> = {
      "/owner.tsx":
        'import { style } from "/style.ts"; import "/pkg/entry.ts"; <div css={{ color: style.color }} />;',
      "/style.ts": 'export const style = { color: "red" };',
      "/pkg/entry.ts": 'import "/pkg/mutate.ts";',
      "/pkg/mutate.ts":
        'import { style } from "/style.ts"; style.color = "blue";'
    };
    const result = await createStaticCssEvalPrepass("/owner.tsx", {
      resolve: (_importer, specifier) => ({
        id: specifier,
        sourceKind: specifier.startsWith("/pkg/")
          ? "package-source"
          : "project-source"
      }),
      load: (id) => ({ sourceText: modules[id]! })
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.result.dependencyFiles).toContain("/pkg/mutate.ts");
    expect(
      result.provider.getResolvedCssValue({
        importerId: "/owner.tsx",
        expressionStart: 0,
        expressionEnd: 1,
        bindingName: "style",
        memberPath: ["color"]
      })
    ).toMatchObject({ kind: "error" });
  });

  it("keeps execution discovery independent of the literal node budget", async () => {
    const names = Array.from({ length: 60 }, (_, index) => `style${index}`);
    const result = await prepass({
      "/owner.tsx": `import { ${names.join(",")} } from "/styles.ts"; <>${names.map((name) => `<div css={${name}} />`).join("")}</>;`,
      "/styles.ts": names
        .map((name) => `export const ${name} = [${"null,".repeat(1_000)}];`)
        .join("\n")
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.result.resolvedModuleCache.size).toBe(2);
  });

  it("discovers broad execution graphs without spending the literal module budget", async () => {
    const modules: Record<string, string> = {
      "/style.ts": 'export const style = { color: "red" };'
    };
    const imports = Array.from(
      { length: internalStaticCssEvalLimits.maxEvaluatedModulesPerOwner + 1 },
      (_, index) => {
        modules[`/${index}.ts`] = "export {};";
        return `import "/${index}.ts";`;
      }
    );
    modules["/owner.tsx"] =
      `import { style } from "/style.ts"; ${imports.join("\n")} <div css={style} />;`;
    const result = await prepass(modules);
    expect(result.diagnostics).toEqual([]);
    expect(result.result.resolvedModuleCache.size).toBe(imports.length + 2);
  });

  it("discards a partial execution graph when its independent limit is exceeded", async () => {
    const modules: Record<string, string> = {
      "/style.ts": 'export const style = { color: "red" };'
    };
    const imports = Array.from(
      { length: STATIC_CSS_EVAL_EXECUTION_LIMITS.modules },
      (_, index) => {
        modules[`/${index}.ts`] = "export {};";
        return `import "/${index}.ts";`;
      }
    );
    modules["/owner.tsx"] =
      `import { style } from "/style.ts"; ${imports.join("\n")} <div css={style} />;`;
    await expectBoundedPrepass(
      modules,
      "execution discovery exceeded max modules"
    );
  });

  it("finishes cyclic import and local expression graphs in a bounded child process", async () => {
    // This source test also participates in CommonJS declaration builds.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore error TS1343
    const prepassUrl = new URL("./staticCssEvalPrepass.ts", import.meta.url);
    const prepassPath = fileURLToPath(prepassUrl);

    const script = `
      import assert from "node:assert/strict";
      import { createStaticCssEvalPrepass } from ${JSON.stringify(prepassPath)};
      const modules = {
        "/owner.tsx": 'import { a } from "/a.ts"; <div css={a} />;',
        "/a.ts": 'import { b } from "/b.ts"; export const a = false ? b : { color: "red" };',
        "/b.ts": 'import { a } from "/a.ts"; export const b = false ? a : { color: "blue" };'
      };
      let loads = 0;
      const provider = {
        resolve: (_importer, specifier) => ({ id: specifier }),
        load: (id) => { loads++; return { sourceText: modules[id] }; }
      };
      const first = await createStaticCssEvalPrepass("/owner.tsx", provider);
      assert.equal(first.result.resolvedModuleCache.size, 3);
      assert.equal(loads, 3);
      modules["/owner.tsx"] = 'const a = false ? b : {color: "red"}; const b = false ? a : {color: "blue"}; <div css={a} />;';
      const second = await createStaticCssEvalPrepass("/owner.tsx", provider);
      assert.equal(second.result.resolvedModuleCache.size, 1);
      process.stdout.write("cycles completed");
    `;

    const compiled = await build({
      stdin: {
        contents: script,
        resolveDir: dirname(prepassPath),
        sourcefile: "prepass-cycles.mjs"
      },
      bundle: true,
      packages: "external",
      platform: "node",
      target: "node20",
      format: "esm",
      write: false
    });

    const execution = execute(
      process.execPath,
      ["--max-old-space-size=256", "--input-type=module", "-"],
      { cwd: dirname(prepassPath), timeout: 10_000, maxBuffer: 64 * 1024 }
    );
    execution.child.stdin!.end(compiled.outputFiles[0]!.text);
    const result = await execution;

    expect(result.stdout).toBe("cycles completed");
  }, 15_000);

  it("keeps dotted property names distinct from nested member paths", async () => {
    const result = await prepass({
      "/owner.tsx":
        'import { styles } from "/styles.ts"; <><div css={styles["a.b"]} /><div css={styles.a.b} /></>;',
      "/styles.ts":
        'import { red } from "/red.ts"; import { blue } from "/blue.ts"; export const styles = { "a.b": red, a: { b: blue } };',
      "/red.ts": 'export const red = { color: "red" };',
      "/blue.ts": 'export const blue = { color: "blue" };'
    });

    expect(result.result.dependencyFiles).toEqual(
      expect.arrayContaining(["/red.ts", "/blue.ts"])
    );
  });

  it("retains many small CSS props beyond a single literal's node limit", async () => {
    const valuesPerProp = 100;
    const names = Array.from(
      {
        length:
          Math.ceil(
            internalStaticCssEvalLimits.maxStaticLiteralNodeCount /
              valuesPerProp
          ) + 1
      },
      (_, index) => `style${index}`
    );
    const owner = `import { ${names.join(",")} } from "/styles.ts"; <>${names.map((name) => `<div css={${name}} />`).join("")}</>;`;
    const result = await prepass({
      "/owner.tsx": owner,
      "/styles.ts": names
        .map(
          (name) =>
            `export const ${name} = [${Array.from({ length: valuesPerProp }, () => "null").join(",")}];`
        )
        .join("\n")
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.result.resolvedModuleCache.size).toBe(2);
    for (const name of names) {
      const start = owner.indexOf(`css={${name}}`) + "css={".length;
      expect(
        result.provider.getResolvedCssValue({
          importerId: "/owner.tsx",
          expressionStart: start,
          expressionEnd: start + name.length,
          bindingName: name
        })
      ).toMatchObject({ kind: "resolved" });
    }
  });

  it("keeps the evaluator's per-literal limit below the owner traversal budget", async () => {
    const owner = 'import { style } from "/large.ts"; <div css={style} />;';
    const valuesPerPart = 100;
    const parts =
      Math.ceil(
        internalStaticCssEvalLimits.maxStaticLiteralNodeCount / valuesPerPart
      ) + 1;
    const result = await prepass({
      "/owner.tsx": owner,
      "/large.ts": `const part = [${Array.from({ length: valuesPerPart }, () => "null").join(",")}]; export const style = [${Array.from({ length: parts }, () => "part").join(",")}];`
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.result.resolvedModuleCache.size).toBe(2);
    expect(
      result.provider.getResolvedCssValue({
        importerId: "/owner.tsx",
        expressionStart: owner.lastIndexOf("style"),
        expressionEnd: owner.lastIndexOf("style") + "style".length,
        bindingName: "style"
      })
    ).toMatchObject({ kind: "error", diagnostic: { code: "limit-exceeded" } });
  });

  it("bounds an acyclic import chain before loading beyond the shared limit", async () => {
    const modules: Record<string, string> = {
      "/owner.tsx": 'import { style } from "/0.ts"; <div css={style} />;'
    };

    for (
      let index = 0;
      index <= internalStaticCssEvalLimits.maxImportDepth;
      index++
    ) {
      modules[`/${index}.ts`] = `export { style } from "/${index + 1}.ts";`;
    }

    await expectBoundedPrepass(modules, "max import depth");
  });

  it("bounds broad dependency graphs", async () => {
    const modules: Record<string, string> = {};
    const names = Array.from(
      { length: internalStaticCssEvalLimits.maxEvaluatedModulesPerOwner + 1 },
      (_, index) => `s${index}`
    );

    modules["/owner.tsx"] =
      names
        .map((name) => `import { style as ${name} } from "/${name}.ts";`)
        .join("\n") + `<div css={[${names.join(",")}]} />;`;

    for (const name of names)
      modules[`/${name}.ts`] = 'export const style = { color: "red" };';

    await expectBoundedPrepass(modules, "max evaluated modules per owner");
  });

  it("bounds expression recursion before exhausting the stack", async () => {
    const count = internalStaticCssEvalLimits.maxObjectArrayRecursionDepth + 1;

    await expectBoundedPrepass(
      {
        "/owner.tsx": 'import { style } from "/deep.ts"; <div css={style} />;',
        "/deep.ts": `export const style = ${"[".repeat(count)}{color: "red"}${"]".repeat(count)};`
      },
      "max object/array recursion depth"
    );
  });

  it.each([
    [
      "max object/array recursion depth",
      () => {
        const depth =
          internalStaticCssEvalLimits.maxObjectArrayRecursionDepth + 1;
        return `${"[".repeat(depth)}{ color: "red" }${"]".repeat(depth)}`;
      }
    ],
    [
      "max traversed node count",
      () =>
        `[${Array.from({ length: STATIC_CSS_EVAL_PREPASS_MAX_TRAVERSED_NODES + 1 }, () => "null").join(",")}]`
    ]
  ] as const)(
    "also bounds owner literals at %s",
    async (message, expression) => {
      const result = await prepass({
        "/owner.tsx": `<div css={${expression()}} />;`
      });
      expect(result.diagnostics[0]?.message).toContain(message);
      expect(result.result.resolvedModuleCache.size).toBe(0);
    }
  );

  it("does not count shallow alias hops as object recursion", async () => {
    const count = internalStaticCssEvalLimits.maxObjectArrayRecursionDepth + 1;
    const aliases = Array.from(
      { length: count },
      (_, index) => `const a${index + 1} = a${index};`
    ).join("\n");

    await expect(
      prepass({
        "/owner.tsx": `const a0 = { color: "red" }; ${aliases} <div css={a${count}} />;`
      })
    ).resolves.toBeDefined();
  });

  it("bounds the total expression walk", async () => {
    const count = STATIC_CSS_EVAL_PREPASS_MAX_TRAVERSED_NODES + 1;

    await expectBoundedPrepass(
      {
        "/owner.tsx": 'import { style } from "/large.ts"; <div css={style} />;',
        "/large.ts": `export const style = [${Array.from({ length: count }, () => "null").join(",")}];`
      },
      "max traversed node count"
    );
  });
});
