import { resolveCssScopeOrigin } from "./fileScopeRuntime.js";
import esbuild from "esbuild";
import { addFileScope } from "@vanilla-extract/integration";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compile,
  currentPackageInfo,
  transformScopedDependency
} from "./compile.js";
import { CompilationCache, cacheDigest } from "./compilationCache.js";
import { processDefineRulesPresetRegistryFile } from "./defineRulesPreset.js";

describe("co-located preset package scopes", () => {
  it("returns existing low-level JSX preserve output with source provenance", async () => {
    const filePath = join(process.cwd(), "src/public-jsx-preserve.css.ts");
    const compiled = await compile({
      filePath,
      originalPath: filePath,
      contents: "export const view = <span />;",
      resolverCache: new Map(),
      plugins: [
        {
          name: "preserve-jsx",
          setup(build) {
            build.initialOptions.jsx = "preserve";
          }
        }
      ]
    });
    expect(compiled.source).toContain("<span />");
    expect(compiled.cssScopeOrigins).toContainEqual(
      expect.objectContaining({ origin: filePath, runtime: expect.any(Object) })
    );
  });

  it("returns standard decorators preserved by a low-level esnext build", async () => {
    const filePath = join(
      process.cwd(),
      "src/public-decorator-preserve.css.ts"
    );
    const result = await compile({
      filePath,
      originalPath: filePath,
      contents: `
        function annotate(value: unknown) { return value; }
        @annotate export class Appearance {}
      `,
      resolverCache: new Map(),
      plugins: [
        {
          name: "preserve-standard-decorators",
          setup(build) {
            build.initialOptions.target = "esnext";
            build.initialOptions.supported = {
              ...build.initialOptions.supported,
              decorators: true
            };
          }
        }
      ]
    });
    expect(result.source).toContain("@annotate");
    expect(result.cssScopeOrigins).toContainEqual(
      expect.objectContaining({ origin: filePath, runtime: expect.any(Object) })
    );
  });

  it("keeps encoded external scopes distinct from literal paths across cache and relocation", async () => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const snapshots: unknown[] = [];
    for (let relocation = 0; relocation < 2; relocation++) {
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache/encoded-scopes-"))
      );
      const app = join(root, "app"),
        filePath = join(app, "owner.css.ts");
      const cache = new CompilationCache();
      cache.configure({ type: "memory" }, root, "scope-encoding");
      try {
        await mkdir(app);
        await writeFile(join(app, "package.json"), '{"name":"encoded-owner"}');
        const entries = [
          "../sibling/index.mjs",
          "%2E%2E/sibling/index.mjs",
          "percent%/hash#.mjs"
        ];
        for (const path of entries) {
          const absolute = join(app, path);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(
            join(dirname(absolute), "package.json"),
            '{"name":"encoded-preset"}'
          );
          await writeFile(
            absolute,
            `import {style} from '@vanilla-extract/css';import {defineRules} from '@mincho-js/css';const rules=defineRules({properties:{display:true}});export const origin=rules.preset.nodes[0].origin;export const name=style({color:'red'});`
          );
        }
        const manual = join(app, "manual.mjs");
        await writeFile(
          manual,
          `import {style} from '@vanilla-extract/css';import {setFileScope as manualScope,endFileScope} from '@vanilla-extract/css/fileScope';manualScope('manual%scope.css.ts','manual-preset');export const name=style({color:'blue'});endFileScope();`
        );
        const contents =
          entries
            .map(
              (path, index) =>
                `import {origin as o${index},name as n${index}} from ${JSON.stringify(path.startsWith(".") ? path : "./" + path)};`
            )
            .join("\n") +
          `import {name as manual} from './manual.mjs';export const values=[o0,n0,o1,n1,o2,n2,manual];`;
        const build = vi.fn(esbuild.build);
        const run = () =>
          compile({
            cwd: app,
            esbuild: { ...esbuild, build },
            filePath,
            originalPath: filePath,
            contents,
            resolverCache: new Map(),
            cache
          });
        const first = await run();
        expect(build).toHaveBeenCalledTimes(1);
        const warm = await run();
        expect(build).toHaveBeenCalledTimes(1);
        expect(warm.source).toBe(first.source);
        expect(warm.cssScopeOrigins).toEqual(first.cssScopeOrigins);
        cache.clear();
        const cold = await run();
        expect(build).toHaveBeenCalledTimes(2);
        expect(cold.source).toBe(first.source);
        expect(cold.cssScopeOrigins).toEqual(first.cssScopeOrigins);
        const artifacts: Array<{
          origin: string;
          fileScope: { filePath: string };
          localClassNames: string[];
        }> = [];
        const output = await processDefineRulesPresetRegistryFile({
          filePath,
          source: warm.source,
          cssScopeOrigins: warm.cssScopeOrigins,
          serializeCssArtifact(artifact) {
            artifacts.push(artifact);
            return "";
          }
        });
        const expected = [
          "%2E%2E/sibling/index.mjs",
          "%252E%252E/sibling/index.mjs",
          "percent%25/hash%23.mjs",
          "manual%scope.css.ts"
        ].sort();
        expect(
          artifacts
            .map((artifact) => [artifact.fileScope.filePath, artifact.origin])
            .sort()
        ).toEqual(
          [
            ["%2E%2E/sibling/index.mjs", join(app, entries[0]!)],
            ["%252E%252E/sibling/index.mjs", join(app, entries[1]!)],
            ["percent%25/hash%23.mjs", join(app, entries[2]!)],
            ["manual%scope.css.ts", manual]
          ].sort()
        );
        for (const path of expected.filter(
          (path) => path !== "manual%scope.css.ts"
        ))
          expect(output.source).toContain(
            `encoded-preset:${path}#defineRules:0`
          );
        snapshots.push(
          artifacts
            .map((artifact) => ({
              scope: artifact.fileScope.filePath,
              classes: artifact.localClassNames
            }))
            .sort((a, b) => a.scope.localeCompare(b.scope))
        );
      } finally {
        cache.clear();
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("distinguishes duplicate installations before class generation and shares repeated physical imports", async () => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await realpath(
      await mkdtemp(join(process.cwd(), ".cache/duplicate-installs-"))
    );
    const filePath = join(root, "owner.css.ts");
    try {
      await writeFile(join(root, "package.json"), '{"name":"instance-owner"}');
      for (const parent of ["a", "b"]) {
        const folder = join(root, parent, "node_modules/preset");
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, "package.json"),
          '{"name":"preset","type":"module"}'
        );
        await writeFile(
          join(folder, "index.mjs"),
          `import {style} from '@vanilla-extract/css';export const name=style({color:'red'});`
        );
      }
      const result = await compile({
        cwd: root,
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents: `import {name as a} from './a/node_modules/preset/index.mjs';import {name as again} from './a/node_modules/preset/index.mjs';import {name as b} from './b/node_modules/preset/index.mjs';export const names=[a,again,b];`
      });
      const artifacts: Array<{
        origin: string;
        fileScope: { filePath: string };
        cssObjs: unknown[];
        localClassNames: string[];
      }> = [];
      await processDefineRulesPresetRegistryFile({
        filePath,
        source: result.source,
        cssScopeOrigins: result.cssScopeOrigins,
        serializeCssArtifact(artifact) {
          artifacts.push(artifact);
          return "";
        }
      });
      expect(artifacts.map((artifact) => artifact.origin).sort()).toEqual([
        join(root, "a/node_modules/preset/index.mjs"),
        join(root, "b/node_modules/preset/index.mjs")
      ]);
      expect(
        new Set(artifacts.map((artifact) => artifact.fileScope.filePath)).size
      ).toBe(2);
      expect(
        artifacts.reduce(
          (count, artifact) => count + artifact.cssObjs.length,
          0
        )
      ).toBe(2);
      expect(
        new Set(artifacts.flatMap((artifact) => artifact.localClassNames)).size
      ).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["\\u005f", "\\u{5f}"])(
    "rejects decoded reserved identifiers in caller-loaded source: %s",
    async (escape) => {
      const filePath = join(process.cwd(), "src/escaped-capability.css.ts");
      const contents = `import value from 'escaped-capability';export {value};`;
      const factoryName =
        "__mincho_css_scope_factory_" +
        cacheDigest(JSON.stringify([filePath, filePath, contents])).slice(
          0,
          48
        );
      const escapedName = escape + factoryName.slice(1);
      await expect(
        compile({
          filePath,
          originalPath: filePath,
          contents,
          resolverCache: new Map(),
          plugins: [
            {
              name: "escaped-author-source",
              setup(build) {
                build.onResolve({ filter: /^escaped-capability$/ }, () => ({
                  path: "escaped-capability",
                  namespace: "caller-source"
                }));
                build.onLoad(
                  { filter: /.*/, namespace: "caller-source" },
                  () => ({
                    contents: `export default typeof ${escapedName};`,
                    loader: "js"
                  })
                );
              }
            }
          ]
        })
      ).rejects.toThrow("collides with author source");
    }
  );

  it("keeps cold compiler source and inline source maps deterministic", async () => {
    const filePath = join(process.cwd(), "src/inline-map.css.ts");
    const run = () =>
      compile({
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents: `import {style} from '@vanilla-extract/css';export const box=style({color:'red'});`,
        plugins: [
          {
            name: "inline-source-map",
            setup(build) {
              build.initialOptions.sourcemap = "inline";
            }
          }
        ]
      });
    const first = await run();
    const second = await run();
    expect(first.source).toContain("sourceMappingURL=data:");
    expect(second.source).toBe(first.source);
    expect(second.cssScopeOrigins).toEqual(first.cssScopeOrigins);
  });

  it("keeps generated lexical bindings separate from author identifiers and dynamic require", async () => {
    const filePath = join(process.cwd(), "src/lexical-scope.css.ts");
    const compileSource = (contents: string) =>
      compile({
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents
      });
    const initial = await compileSource(
      `import {style} from '@vanilla-extract/css';export const box=style({color:'red'});`
    );
    const registration = initial.cssScopeOrigins.find(
      (entry) => entry.runtime
    )!.runtime!;
    const collision = await compileSource(
      `import {style} from '@vanilla-extract/css';const ${registration.factoryName}=123;export const value=${registration.factoryName};export const box=style({color:'red'});`
    );
    expect(collision.cssScopeOrigins[0]!.runtime!.factoryName).not.toBe(
      registration.factoryName
    );
    const artifacts: unknown[] = [];
    const output = await processDefineRulesPresetRegistryFile({
      filePath,
      source: collision.source,
      cssScopeOrigins: collision.cssScopeOrigins,
      serializeCssArtifact(artifact) {
        artifacts.push(artifact);
        return "";
      }
    });
    expect(output.source).toContain("123");
    expect(artifacts).toHaveLength(1);
    const dynamic = await compileSource(
      `const load=name=>require(name);export const value=load(${JSON.stringify(registration.id)});`
    );
    const serializeUnexpected = vi.fn(() => "");
    await expect(
      processDefineRulesPresetRegistryFile({
        filePath,
        source: dynamic.source,
        cssScopeOrigins: dynamic.cssScopeOrigins,
        serializeCssArtifact: serializeUnexpected
      })
    ).rejects.toThrow();
    expect(serializeUnexpected).not.toHaveBeenCalled();
    await expect(
      compileSource(
        `import value from ${JSON.stringify(registration.id)};export {value};`
      )
    ).rejects.toThrow("Private CSS scope runtime modules");
  });

  it.each([
    {
      name: "dynamic scope",
      source: `import * as scope from '@vanilla-extract/css/fileScope';scope.setFileScope('empty.css.ts','pkg');scope.endFileScope();const dynamic='dynamic.css.ts';scope.setFileScope(dynamic,'pkg');`,
      valid: true
    },
    {
      name: "reassigned fake namespace",
      source: `let scope=require('@vanilla-extract/css/fileScope');scope={setFileScope:()=>{},endFileScope:()=>{}};scope.setFileScope('first','pkg');`,
      valid: false
    },
    {
      name: "escaped original method",
      source: `import * as scope from '@vanilla-extract/css/fileScope';const escaped=scope.setFileScope;escaped('first','pkg');`,
      valid: true
    },
    {
      name: "computed original method",
      source: `import * as scope from '@vanilla-extract/css/fileScope';const key='setFileScope';scope[key]('first','pkg');`,
      valid: true
    },
    {
      name: "unregistered same-tuple reentry",
      source: `import * as registered from '@vanilla-extract/css/fileScope';registered.setFileScope('registered-first.css.ts','pkg');registered.endFileScope();registered.setFileScope('shared.css.ts','pkg');registered.endFileScope();const load=name=>require(name);const scope=load('@vanilla-extract/css/fileScope');scope.setFileScope('shared.css.ts','pkg');`,
      valid: false
    },
    {
      name: "writes acquired namespace",
      source: `const scope=require('@vanilla-extract/css/fileScope');scope.setFileScope=()=>{};scope.setFileScope('first','pkg');`,
      valid: false
    },
    {
      name: "ordinary dynamic require bypass",
      source: `const load=name=>require(name);const scope=load('@vanilla-extract/css/fileScope');scope.setFileScope('unregistered.css.ts','pkg');`,
      valid: false
    }
  ])(
    "checks actual artifact receipts for $name",
    async ({ name, source, valid }) => {
      const filePath = join(process.cwd(), "src/actual-forwarding.css.ts");
      const compiled = await compile({
        filePath,
        originalPath: filePath,
        resolverCache: new Map(),
        contents:
          source +
          `import {style} from '@vanilla-extract/css';export const className=style({color:'red'});scope.endFileScope();`
      });
      const artifacts: Array<{
        origin: string;
        fileScope: { filePath: string };
      }> = [];
      const evaluate = () =>
        processDefineRulesPresetRegistryFile({
          filePath,
          source: compiled.source,
          cssScopeOrigins: compiled.cssScopeOrigins,
          serializeCssArtifact(artifact) {
            artifacts.push(artifact);
            return "";
          }
        });
      if (valid) {
        await evaluate();
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]!.origin).toBe(filePath);
        if (name === "dynamic scope")
          expect(artifacts[0]!.fileScope.filePath).toBe("dynamic.css.ts");
      } else {
        if (name === "unregistered same-tuple reentry")
          await expect(evaluate()).rejects.toThrow(
            "Missing CSS scope provenance: unattributed runtime scope instance"
          );
        else await expect(evaluate()).rejects.toThrow();
        expect(artifacts).toEqual([]);
      }
    }
  );

  it.each([false, true, "inherited-bypass"] as const)(
    "observes actual CJS namespace forwarding scopes (fallback override: %s)",
    async (override) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "runtime-scopes-"))
      );
      try {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ name: "runtime-scopes" })
        );
        const dependency = join(root, "published.cjs");
        await writeFile(
          dependency,
          `
        ${override === true ? `exports.__importStar = mod => ({...mod,['setFileScope']:(path,pkg)=>mod['setFileScope']('redirected.css.ts',pkg)});` : ""}
        ${override === "inherited-bypass" ? `const helperPrototype=Object.getPrototypeOf(exports);const previousHelper=Object.getOwnPropertyDescriptor(helperPrototype,'__importStar');Object.defineProperty(helperPrototype,'__importStar',{configurable:true,value:()=>{const load=name=>require(name);return load('@vanilla-extract/css/fileScope');}});` : ""}
        var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o,m,k,k2){if(k2===undefined)k2=k;var desc=Object.getOwnPropertyDescriptor(m,k);if(!desc||("get" in desc ? !m.__esModule:desc.writable||desc.configurable))desc={enumerable:true,get:function(){return m[k]}};Object.defineProperty(o,k2,desc);}) : function(o,m,k,k2){if(k2===undefined)k2=k;o[k2]=m[k];});
        var __setModuleDefault=(this&&this.__setModuleDefault)||(Object.create?function(o,v){Object.defineProperty(o,"default",{enumerable:true,value:v});}:function(o,v){o["default"]=v;});
        var __importStar=(this&&this.__importStar)||function(mod){if(mod&&mod.__esModule)return mod;var result={};if(mod!=null)for(var k in mod)if(k!=="default"&&Object.prototype.hasOwnProperty.call(mod,k))__createBinding(result,mod,k);__setModuleDefault(result,mod);return result;};
        ${override === "inherited-bypass" ? `if(previousHelper)Object.defineProperty(helperPrototype,'__importStar',previousHelper);else delete helperPrototype.__importStar;` : ""}
        const scope=__importStar(require('@vanilla-extract/css/fileScope'));
        const {style}=require('@vanilla-extract/css');
        scope.setFileScope('first.css.ts','published');scope.endFileScope();
        scope.setFileScope('second.css.ts','published');exports.red=style({color:'red'});scope.endFileScope();
      `
        );
        const options = {
          cwd: root,
          filePath: join(root, "owner.css.ts"),
          originalPath: join(root, "owner.css.ts"),
          contents: "export {red} from './published.cjs';",
          resolverCache: new Map<string, string>()
        };
        const first = await compile(options),
          second = await compile({ ...options, resolverCache: new Map() });
        expect(second.source).toBe(first.source);
        expect(second.cssScopeOrigins).toEqual(first.cssScopeOrigins);
        const artifacts: Array<{
          origin: string;
          fileScope: { filePath: string };
        }> = [];
        const evaluate = () =>
          processDefineRulesPresetRegistryFile({
            source: first.source,
            filePath: options.filePath,
            cssScopeOrigins: first.cssScopeOrigins,
            serializeCssArtifact(artifact) {
              artifacts.push(artifact);
              return "";
            }
          });
        if (override === "inherited-bypass") {
          await expect(evaluate()).rejects.toThrow(
            "Missing CSS scope provenance"
          );
          expect(artifacts).toEqual([]);
          return;
        }
        await evaluate();
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]!.origin).toBe(dependency);
        expect(artifacts[0]!.fileScope.filePath).toBe(
          override ? "redirected.css.ts" : "second.css.ts"
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "pins the supplied entry's CSS and assets across an async manifest read (persistent: %s)",
    async (persistent) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "entry-origin-snapshot-"))
      );
      try {
        const owner = join(root, "owner");
        const other = join(root, "other");
        const filePath = join(owner, "theme.css.ts");
        const target = join(other, "theme.css.ts");
        const manifest = join(owner, "package.json");
        for (const [directory, color] of [
          [owner, "red"],
          [other, "blue"]
        ] as const) {
          await mkdir(directory);
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({ name: color + "-package" })
          );
          await writeFile(join(directory, "theme.css.ts"), "export {};");
          await writeFile(join(directory, "icon.svg"), `<svg>${color}</svg>`);
        }
        let replaced = false;
        const relocateEntry = async (path: string) => {
          if (path !== manifest || replaced) return;
          replaced = true;
          await rm(filePath);
          await symlink(target, filePath);
        };
        const makeCache = () => {
          const cache = new CompilationCache();
          cache.configure(undefined, join(root, "results"), "entry-origin");
          return cache;
        };
        const build = vi.fn(esbuild.build);
        const options = {
          filePath,
          originalPath: filePath,
          cwd: owner,
          contents: `import {globalStyle} from '@vanilla-extract/css';
          globalStyle('.entry',{color:'red',backgroundImage:'url("./icon.svg")'});`,
          esbuild: { ...esbuild, build },
          resolverCache: new Map()
        };
        let compiled: Awaited<ReturnType<typeof compile>>;
        if (persistent) {
          const cache = makeCache();
          const readOptional = cache.readOptionalFile.bind(cache);
          vi.spyOn(cache, "readOptionalFile").mockImplementation(
            async (path) => {
              const value = await readOptional(path);
              await relocateEntry(path);
              return value;
            }
          );
          compiled = await compile({ ...options, cache });
        } else {
          compiled = await compile({
            ...options,
            async readPackageFile(path) {
              const text = await readFile(path, "utf8");
              await relocateEntry(path);
              return text;
            }
          });
        }
        expect(replaced).toBe(true);
        expect(await realpath(filePath)).toBe(target);
        if (persistent) {
          // A subsequent request has the original canonical path and same
          // source bytes again; an earlier mislabeled persisted origin could hit.
          await rm(filePath);
          await writeFile(filePath, "export {};");
          compiled = await compile({ ...options, cache: makeCache() });
          expect(build).toHaveBeenCalledTimes(1);
        }
        const artifacts: unknown[] = [];
        await processDefineRulesPresetRegistryFile({
          ...compiled,
          filePath,
          async serializeCssArtifact(artifact) {
            artifacts.push({
              origin: artifact.origin,
              scope: artifact.fileScope,
              css: artifact.cssObjs,
              asset: await readFile(
                join(dirname(artifact.origin), "icon.svg"),
                "utf8"
              )
            });
            return "";
          }
        });
        expect(artifacts).toEqual([
          {
            origin: filePath,
            scope: { filePath: "theme.css.ts", packageName: "red-package" },
            css: expect.arrayContaining([
              expect.objectContaining({
                rule: { color: "red", backgroundImage: 'url("./icon.svg")' }
              })
            ]),
            asset: "<svg>red</svg>"
          }
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("normalizes an empty package name through actual artifact evaluation", async () => {
    const filePath = join(process.cwd(), "src/empty-package.css.ts");
    const result = await compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope';
      import {style} from '@vanilla-extract/css';
      setFileScope('first.css.ts','fixture');endFileScope();
      setFileScope('unnamed.css.ts','');export const className=style({color:'rebeccapurple'});endFileScope();`
    });
    const scope = result.cssScopeOrigins.find(
      (entry) => entry.fileScope.filePath === "unnamed.css.ts"
    )!;
    expect(scope.fileScope.packageName).toBeUndefined();
    const artifacts: Array<{
      origin: string;
      fileScope: { filePath: string; packageName?: string };
    }> = [];
    await processDefineRulesPresetRegistryFile({
      source: result.source,
      filePath,
      cssScopeOrigins: result.cssScopeOrigins,
      serializeCssArtifact(artifact) {
        artifacts.push(artifact);
        return "";
      }
    });
    expect(artifacts).toEqual([
      expect.objectContaining({
        origin: filePath,
        fileScope: { filePath: "unnamed.css.ts" }
      })
    ]);
    expect(
      resolveCssScopeOrigin({ filePath: "unnamed.css.ts" }, [
        {
          fileScope: { filePath: "unnamed.css.ts", packageName: "" },
          origin: filePath
        }
      ])
    ).toBe(filePath);
    expect(() =>
      resolveCssScopeOrigin({ filePath: "unnamed.css.ts", packageName: "" }, [
        { fileScope: scope.fileScope, origin: scope.origin },
        { fileScope: scope.fileScope, origin: filePath + ".other" }
      ])
    ).toThrow("Ambiguous CSS file scope");
  });

  it.each([false, true])(
    "uses snapshot ownership across manifest ABA (initially missing: %s)",
    async (missing) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "ownership-snapshot-"))
      );
      const cache = new CompilationCache();
      const manifest = join(root, "nested/package.json");
      try {
        await mkdir(join(root, "nested"));
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ name: "parent-A" })
        );
        if (!missing)
          await writeFile(manifest, JSON.stringify({ name: "nested-A" }));
        await writeFile(
          join(root, "nested/value.ts"),
          "export const value=42;"
        );
        const build = vi.fn(
          async (options: Parameters<typeof esbuild.build>[0]) => {
            if (build.mock.calls.length > 1) return esbuild.build(options);
            await writeFile(manifest, JSON.stringify({ name: "transient-B" }));
            try {
              return await esbuild.build(options);
            } finally {
              if (missing) await rm(manifest);
              else
                await writeFile(manifest, JSON.stringify({ name: "nested-A" }));
            }
          }
        );
        const run = () =>
          compile({
            cache,
            esbuild: { ...esbuild, build },
            cwd: root,
            filePath: join(root, "entry.ts"),
            originalPath: join(root, "entry.ts"),
            contents: "export {value} from './nested/value.ts';",
            resolverCache: new Map()
          });
        const first = await cache.withInputs(async () => {
          await cache.fingerprint([manifest]);
          return run();
        });
        expect(
          first.cssScopeOrigins.find(
            (entry) => entry.origin === join(root, "nested/value.ts")
          )?.fileScope.packageName
        ).toBe(missing ? "parent-A" : "nested-A");
        expect(first.watchFiles).toContain(manifest);
        const replay = await run();
        expect(replay.cssScopeOrigins).toEqual(first.cssScopeOrigins);
        // A transient newly resolvable manifest may conservatively prevent caching.
        expect(build).toHaveBeenCalledTimes(missing ? 2 : 1);
        expect((await run()).cssScopeOrigins).toEqual(first.cssScopeOrigins);
        expect(build).toHaveBeenCalledTimes(missing ? 2 : 1);
      } finally {
        cache.clear();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("collects scopes from the final configured Babel AST", async () => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await realpath(
      await mkdtemp(join(process.cwd(), ".cache", "configured-scopes-"))
    );
    try {
      await writeFile(
        join(root, ".babelrc.cjs"),
        `module.exports={plugins:[function(){return {manipulateOptions(_,parser){parser.plugins.push('decorators-legacy')},visitor:{ClassDeclaration(path){path.remove()},StringLiteral(path){if(path.node.value==='before.css.ts')path.node.value='after.css.ts'}}}}]};`
      );
      const result = transformScopedDependency({
        contents: `import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope'; @decorator class Example {} setFileScope('initial.css.ts','fixture'); endFileScope(); setFileScope('before.css.ts',''); endFileScope();`,
        filePath: join(root, "scope.js"),
        loader: "js",
        packageName: "fixture",
        rootPath: root
      });
      expect(result.cssScopeOrigins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileScope: { filePath: "after.css.ts", packageName: undefined }
          })
        ])
      );
      expect(
        result.cssScopeOrigins.some(
          (entry) => entry.fileScope.filePath === "before.css.ts"
        )
      ).toBe(false);
      expect(result.source).not.toContain("@decorator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores erased scope references while preserving runtime literal calls", async () => {
    const filePath = join(process.cwd(), "src/typed-scope.css.ts");
    const result = await compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `
      import {setFileScope as scope,endFileScope} from '@vanilla-extract/css/fileScope';
      import type {setFileScope as TypeOnlyScope} from '@vanilla-extract/css/fileScope';
      type Scope = typeof scope;
      type Other = typeof TypeOnlyScope;
      export type {Scope,Other};
      scope('real.css.ts','real-package');endFileScope();
      export const value = 1;
    `
    });
    expect(
      result.cssScopeOrigins.some(
        (entry) =>
          entry.fileScope.filePath === "real.css.ts" &&
          entry.fileScope.packageName === "real-package"
      )
    ).toBe(true);
    expect(result.source).not.toContain("TypeOnlyScope");
  });

  it.each(["esm", "cjs"] as const)(
    "records every scope in a published %s bundle without guessing source paths",
    async (format) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "published-scopes-"))
      );
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"published-scope-fixture","type":"module"}'
        );
        for (const color of ["red", "blue"])
          await writeFile(
            join(root, `${color}.js`),
            addFileScope({
              source: `import {style} from '@vanilla-extract/css';export const ${color}=style({color:'${color}',backgroundImage:"url('./${color}.svg')"});`,
              filePath: join(root, `original/${color}.css.ts`),
              rootPath: root,
              packageName: "original-styles"
            })
          );
        const entry = join(root, "entry.js");
        const owner = join(root, "owner.css.ts");
        for (const count of [1, 2]) {
          await writeFile(
            entry,
            count === 1
              ? "export {red} from './red.js';"
              : "export {red} from './red.js';export {blue} from './blue.js';"
          );
          const bundle = join(
            root,
            format === "esm" ? "index.mjs" : "index.cjs"
          );
          await esbuild.build({
            entryPoints: [entry],
            outfile: bundle,
            bundle: true,
            platform: "node",
            format,
            external: ["@vanilla-extract/*"],
            logLevel: "silent"
          });
          const cache = new CompilationCache();
          const build = vi.fn(esbuild.build);
          const run = () =>
            compile({
              cache,
              esbuild: { ...esbuild, build },
              filePath: owner,
              originalPath: owner,
              cwd: root,
              contents: `export * from './${format === "esm" ? "index.mjs" : "index.cjs"}';`,
              resolverCache: new Map()
            });
          const result = await run();
          expect(build).toHaveBeenCalledTimes(1);
          const replay = await run();
          expect(build).toHaveBeenCalledTimes(1);
          expect(replay.cssScopeOrigins).toEqual(result.cssScopeOrigins);
          const artifacts: {
            origin: string;
            scope: string;
            color: unknown;
          }[] = [];
          await processDefineRulesPresetRegistryFile({
            ...replay,
            filePath: owner,
            serializeCssArtifact(artifact) {
              artifacts.push({
                origin: artifact.origin,
                scope: artifact.fileScope.filePath,
                color: artifact.cssObjs
              });
              return "";
            }
          });
          expect(artifacts).toHaveLength(count);
          expect(artifacts.map((item) => item.origin)).toEqual(
            Array(count).fill(bundle)
          );
          expect(artifacts).toEqual(
            ["red", "blue"].slice(0, count).map((color) => ({
              origin: bundle,
              // Vanilla Extract's configured transform rewrites the first
              // ESM setFileScope to this published bundle's logical scope.
              scope:
                format === "esm" && color === "red"
                  ? "index.mjs"
                  : `original/${color}.css.ts`,
              color: expect.arrayContaining([
                expect.objectContaining({
                  rule: expect.objectContaining({ color })
                })
              ])
            }))
          );
          expect(
            result.cssScopeOrigins.some((item) =>
              item.origin.includes("/original/")
            )
          ).toBe(false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "import * as scope from '@vanilla-extract/css/fileScope'; scope.setFileScope('first','pkg'); scope.endFileScope(); scope.setFileScope(dynamic,'pkg');",
    "let scope=require('@vanilla-extract/css/fileScope'); scope={setFileScope:()=>{}}; scope.setFileScope('first','pkg');",
    "import * as scope from '@vanilla-extract/css/fileScope'; const escaped=scope.setFileScope; escaped('first','pkg');",
    "import * as scope from '@vanilla-extract/css/fileScope'; scope[key]('first','pkg');"
  ])(
    "keeps unsupported static scope shapes as runtime-only registrations (%s)",
    async (contents) => {
      const filePath = join(process.cwd(), "src/unproved-scopes.css.ts");
      const compiled = await compile({
        filePath,
        originalPath: filePath,
        contents,
        resolverCache: new Map()
      });
      expect(compiled.cssScopeOrigins.length).toBeGreaterThan(0);
      expect(compiled.cssScopeOrigins.every((entry) => entry.runtime)).toBe(
        true
      );
      expect(() =>
        resolveCssScopeOrigin(
          { filePath: "first", packageName: "pkg" },
          compiled.cssScopeOrigins
        )
      ).toThrow("Missing CSS scope provenance");
    }
  );

  it("does not assign provenance to shadowed or unrelated scope-like functions", async () => {
    const filePath = join(process.cwd(), "src/scope-lookalikes.css.ts");
    const result = await compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `
      import {setFileScope as actual,endFileScope} from '@vanilla-extract/css/fileScope';
      actual('real.css.ts','real-package');endFileScope();
      function local(actual){actual('shadow.css.ts','shadow-package');}
      const fake={setFileScope:()=>{}};fake.setFileScope('fake.css.ts','fake-package');
      function shadow(require){require('@vanilla-extract/css/fileScope').setFileScope('other.css.ts','other-package');}
      export {local,shadow};
    `
    });
    const names = result.cssScopeOrigins.map(
      (item) => item.fileScope.packageName
    );
    expect(names).toContain("real-package");
    expect(names).not.toContain("shadow-package");
    expect(names).not.toContain("fake-package");
    expect(names).not.toContain("other-package");
  });

  it.each(["owner.css.ts", "index.mjs"])(
    "never reconstructs a same-name foreign package origin from %s",
    async (entry) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "origin-collision-"))
      );
      try {
        for (const name of ["app", "dependency"]) {
          await mkdir(join(root, name));
          await writeFile(
            join(root, name, "package.json"),
            '{"name":"same-name","type":"module"}'
          );
        }
        const dependency = join(root, "dependency/index.mjs");
        await writeFile(
          dependency,
          `import {style} from '@vanilla-extract/css';export const color=style({color:'red',backgroundImage:"url('./image.svg')"});`
        );
        const app = join(root, "app"),
          filePath = join(app, entry);
        const contents = "export {color} from '../dependency/index.mjs';";
        await writeFile(join(app, "index.mjs"), "export const unrelated=1;");
        await writeFile(filePath, contents);
        const compiled = await compile({
          cwd: app,
          filePath,
          originalPath: filePath,
          contents,
          resolverCache: new Map()
        });
        const artifacts: string[] = [];
        const evaluate = (mapped: boolean) =>
          processDefineRulesPresetRegistryFile({
            source: compiled.source,
            ...(mapped ? { cssScopeOrigins: compiled.cssScopeOrigins } : {}),
            filePath,
            cssSourceFile: filePath,
            cssSourceRoot: app,
            serializeCssArtifact(artifact) {
              artifacts.push(artifact.origin);
              return "";
            }
          });
        await expect(evaluate(false)).rejects.toThrow(
          "Missing CSS scope provenance"
        );
        expect(artifacts).toEqual([]);
        await evaluate(true);
        expect(artifacts).toEqual([dependency]);
        // No artifact means there is no physical-origin obligation.
        const empty = await compile({
          cwd: app,
          filePath,
          originalPath: filePath,
          contents: "export const value=1;",
          resolverCache: new Map()
        });
        await expect(
          processDefineRulesPresetRegistryFile({
            source: empty.source,
            filePath,
            serializeCssArtifact: () => {
              throw new Error("unexpected CSS");
            }
          })
        ).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, "memory", "filesystem"] as const)(
    "keeps compiled CSS scope provenance through cache and package edits (%s)",
    async (cached) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "css-origins-"))
      );
      const app = join(root, "app"),
        filePath = join(app, "owner.css.ts");
      const cache = cached ? new CompilationCache() : undefined;
      const createCache = () => {
        const next = new CompilationCache();
        next.configure(undefined, join(root, "cache"), "css-origins");
        return next;
      };
      const build = vi.fn(esbuild.build);
      try {
        await mkdir(app);
        await writeFile(join(app, "package.json"), '{"name":"scope-app"}');
        for (const [name, color] of [
          ["first", "red"],
          ["second", "blue"]
        ]) {
          await mkdir(join(root, name));
          await writeFile(
            join(root, name, "package.json"),
            JSON.stringify({ name: `scope-${name}` })
          );
          await writeFile(
            join(root, name, "index.mjs"),
            `import {style} from '@vanilla-extract/css';export const className=style({color:'${color}',backgroundImage:"url('./image.svg')"});`
          );
        }
        const contents =
          "import {className as first} from '../first/index.mjs';import {className as second} from '../second/index.mjs';export const classes=[first,second];";
        const run = () =>
          compile({
            cwd: app,
            filePath,
            originalPath: filePath,
            contents,
            cache: cached === "filesystem" ? createCache() : cache,
            esbuild: { ...esbuild, build },
            resolverCache: new Map()
          });
        const evaluate = async (
          compiled: Awaited<ReturnType<typeof compile>>,
          origins = compiled.cssScopeOrigins
        ) => {
          const artifacts: Array<{
            origin: string;
            fileScope: { filePath: string; packageName?: string };
          }> = [];
          await processDefineRulesPresetRegistryFile({
            source: compiled.source,
            filePath,
            cssSourceFile: filePath,
            cssSourceRoot: app,
            cssScopeOrigins: origins,
            serializeCssArtifact: (artifact) => {
              artifacts.push(artifact);
              return "";
            }
          });
          return artifacts;
        };
        const first = await run();
        const expected = [
          join(root, "first/index.mjs"),
          join(root, "second/index.mjs")
        ].sort();
        expect((await evaluate(first)).map((a) => a.origin).sort()).toEqual(
          expected
        );
        const second = await run();
        expect(second.cssScopeOrigins).toEqual(first.cssScopeOrigins);
        if (cached) expect(build).toHaveBeenCalledTimes(1);
        first.cssScopeOrigins.length = 0;
        expect(
          (await evaluate(await run())).map((a) => a.origin).sort()
        ).toEqual(expected);
        await expect(
          processDefineRulesPresetRegistryFile({
            source: second.source,
            filePath,
            cssSourceFile: filePath,
            cssSourceRoot: app,
            serializeCssArtifact: () => ""
          })
        ).rejects.toThrow("Missing CSS scope provenance");
        await writeFile(
          join(root, "first/package.json"),
          '{"name":"scope-renamed"}'
        );
        const renamed = await run();
        expect(
          (await evaluate(renamed)).map((a) => a.fileScope.packageName).sort()
        ).toEqual(["scope-renamed", "scope-second"]);
        await writeFile(
          join(root, "second/package.json"),
          '{"name":"scope-renamed"}'
        );
        const sameName = await evaluate(await run());
        expect(sameName.map((artifact) => artifact.origin).sort()).toEqual(
          expected
        );
        expect(
          new Set(sameName.map((artifact) => artifact.fileScope.filePath)).size
        ).toBe(2);
        expect(
          sameName.map((artifact) => artifact.fileScope.packageName)
        ).toEqual(["scope-renamed", "scope-renamed"]);
      } finally {
        cache?.clear();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "refreshes added, edited and removed package boundaries (cache: %s)",
    async (cached) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "scope-refresh-"))
      );
      const nested = join(root, "nested");
      const manifest = join(nested, "package.json");
      const filePath = join(root, "extracted_refresh.css.ts");
      const cache = cached ? new CompilationCache() : undefined;
      const resolverCache = new Map<string, string>();
      try {
        await mkdir(nested);
        await writeFile(join(root, "package.json"), '{"name":"scope-parent"}');
        await writeFile(
          join(nested, "index.mjs"),
          `import { defineRules } from "@mincho-js/css";
           const rules = defineRules({properties:{color:true}});
           export const preset = rules.preset;`
        );
        const run = async (origin: string) => {
          const compiled = await compile({
            cwd: root,
            filePath,
            originalPath: join(root, "app.tsx"),
            contents: `import {preset} from "./nested/index.mjs";
                       export const origin = preset.nodes[0].origin;`,
            resolverCache,
            cache
          });
          expect(compiled.watchFiles).toContain(manifest);
          const evaluated = await processDefineRulesPresetRegistryFile({
            source: compiled.source,
            filePath,
            serializeVirtualCssPath: () => ""
          });
          expect(evaluated.source).toContain(origin);
        };
        await run("scope-parent:nested/index.mjs#defineRules:0");
        await writeFile(manifest, '{"name":"scope-added"}');
        await run("scope-added:nested/index.mjs#defineRules:0");
        await writeFile(manifest, '\uFEFF{"name":"scope-bom"}');
        expect(currentPackageInfo(nested, new Set())).toMatchObject({
          name: "scope-bom",
          dirname: nested,
          path: manifest
        });
        await writeFile(manifest, '\uFEFF{"name":');
        expect(() => currentPackageInfo(nested, new Set())).toThrow(
          SyntaxError
        );
        await writeFile(manifest, '{"name":"scope-edited"}');
        await run("scope-edited:nested/index.mjs#defineRules:0");
        await writeFile(manifest, "{}");
        await run("scope-parent:nested/index.mjs#defineRules:0");
        await rm(manifest);
        await run("scope-parent:nested/index.mjs#defineRules:0");
        await writeFile(join(root, "package.json"), '{"name":"scope-renamed"}');
        await run("scope-renamed:nested/index.mjs#defineRules:0");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "preserves sibling and nested package origins with a caller loader: %s",
    async (callerLoader) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await realpath(
        await mkdtemp(join(process.cwd(), ".cache", "mincho-preset-scopes-"))
      );
      const app = join(root, "app");
      const preset = join(root, "preset");
      const nested = join(preset, "nested");
      const filePath = join(app, "extracted_test.css.ts");

      try {
        await mkdir(app);
        await mkdir(nested, { recursive: true });
        await Promise.all([
          writeFile(join(app, "package.json"), '{"name":"scope-consumer"}'),
          writeFile(join(preset, "package.json"), '{"name":"scope-preset"}'),
          writeFile(join(nested, "package.json"), '{"name":"scope-nested"}'),
          writeFile(
            join(nested, "index.mjs"),
            `import { defineRules } from "@mincho-js/css";
             const definition = defineRules({ properties: { display: true } });
             export const nestedPreset = definition.preset;`
          ),
          writeFile(
            join(preset, "index.mjs"),
            `import { defineRules } from "@mincho-js/css";
             export { nestedPreset } from "./nested/index.mjs";
             const definition = defineRules({ properties: { color: { brand: "royalblue" } } });
             export const css = definition.css;
             export const preset = definition.preset;`
          )
        ]);

        const compiled = await compile({
          cwd: app,
          filePath,
          originalPath: join(app, "app.tsx"),
          contents: `import { css, preset, nestedPreset } from "../preset/index.mjs";
                     export const root = css({ color: "brand" });
                     export const origins = [preset.nodes[0].origin, nestedPreset.nodes[0].origin];`,
          resolverCache: new Map(),
          plugins: callerLoader
            ? [
                {
                  name: "preset-source-loader",
                  setup(build) {
                    build.onLoad({ filter: /\.mjs$/ }, async ({ path }) => ({
                      contents: await readFile(path, "utf8"),
                      loader: "js"
                    }));
                  }
                }
              ]
            : []
        });
        const css: string[] = [];
        const evaluated = await processDefineRulesPresetRegistryFile({
          source: compiled.source,
          filePath,
          serializeVirtualCssPath: ({ source }) => {
            css.push(source);

            return "";
          }
        });

        expect(evaluated.source).toContain(
          "scope-preset:%2E%2E/preset/index.mjs#defineRules:0"
        );
        expect(evaluated.source).toContain(
          "scope-nested:%2E%2E/preset/nested/index.mjs#defineRules:0"
        );
        expect(css.join("\n")).toContain("color: royalblue");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

it.each([false, true])(
  "skips package.json directories only in ownership lookup (cache %s)",
  async (cached) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await realpath(
      await mkdtemp(join(process.cwd(), ".cache/manifest-directory-"))
    );
    try {
      const nested = join(root, "nested");
      await mkdir(nested);
      await mkdir(join(nested, "package.json"));
      await writeFile(join(root, "package.json"), '{"name":"named-parent"}');
      const watches = new Set<string>();
      expect(currentPackageInfo(nested, watches).name).toBe("named-parent");
      expect(watches.has(join(nested, "package.json"))).toBe(true);
      const result = await compile({
        cwd: root,
        filePath: join(nested, "entry.css.js"),
        originalPath: join(nested, "entry.js"),
        contents: "export const value=1;",
        resolverCache: new Map(),
        cache: cached ? new CompilationCache() : undefined
      });
      expect(result.watchFiles).toContain(join(nested, "package.json"));
      expect(
        result.cssScopeOrigins.some(
          (x) => x.fileScope.packageName === "named-parent"
        )
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  "rejects a new nearest package manifest created after ownership lookup (cached: %s)",
  async (cached) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await realpath(
      await mkdtemp(join(process.cwd(), ".cache/ownership-transition-"))
    );
    try {
      const nested = join(root, "nested"),
        manifest = join(nested, "package.json");
      await mkdir(nested);
      await mkdir(manifest);
      await writeFile(join(root, "package.json"), '{"name":"original-parent"}');
      expect(currentPackageInfo(nested, new Set()).name).toBe(
        "original-parent"
      );
      const cache = cached ? new CompilationCache() : undefined;
      await expect(
        compile({
          cwd: root,
          filePath: join(nested, "entry.css.js"),
          originalPath: join(nested, "entry.js"),
          contents: "export const value=1;",
          resolverCache: new Map(),
          cache,
          plugins: [
            {
              name: "manifest-transition",
              setup(build) {
                build.onStart(async () => {
                  await rm(manifest, { recursive: true });
                  await writeFile(manifest, '{"name":"new-nearest"}');
                });
              }
            }
          ]
        })
      ).rejects.toThrow("inputs changed during compilation");
      expect(currentPackageInfo(nested, new Set()).name).toBe("new-nearest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  "uses one logical root for a package name (distinct same-name package roots: %s)",
  async (separatePackage) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await realpath(
      await mkdtemp(join(process.cwd(), ".cache", "shared-package-root-"))
    );
    try {
      const cwd = join(root, "site");
      const filePath = join(root, "src/theme.css.ts");
      const dependency = join(cwd, "src/theme.css.ts");
      await mkdir(dirname(filePath), { recursive: true });
      await mkdir(dirname(dependency), { recursive: true });
      await writeFile(join(root, "package.json"), '{"name":"shared-package"}');
      if (separatePackage)
        await writeFile(join(cwd, "package.json"), '{"name":"shared-package"}');
      const alias = join(cwd, "src/alias.css.ts");
      await symlink(dependency, alias);
      const contents = `import "../site/src/theme.css.ts"; import "../site/src/alias.css.ts";
      import { globalStyle } from "@vanilla-extract/css";
      globalStyle(".from-entry", { color: "red" });`;
      await writeFile(
        dependency,
        `import { globalStyle } from "@vanilla-extract/css";
      globalStyle(".from-dependency", { color: "blue" });`
      );
      const cache = new CompilationCache();
      const build = vi.fn(esbuild.build);
      const run = () =>
        compile({
          cwd,
          filePath,
          originalPath: filePath,
          contents,
          cache,
          esbuild: { ...esbuild, build },
          resolverCache: new Map()
        });
      const cold = await run();
      const compiled = await run();
      expect(build).toHaveBeenCalledTimes(1);
      expect(compiled.cssScopeOrigins).toEqual(cold.cssScopeOrigins);
      expect(
        compiled.cssScopeOrigins.filter((entry) => entry.runtime)
      ).toHaveLength(2);
      const selectors: Array<[string, string, string]> = [];
      await processDefineRulesPresetRegistryFile({
        filePath,
        source: compiled.source,
        cssScopeOrigins: compiled.cssScopeOrigins,
        serializeCssArtifact(artifact) {
          selectors.push([
            artifact.fileScope.filePath,
            artifact.origin,
            artifact.cssObjs
              .map((rule) => (rule.type === "global" ? rule.selector : ""))
              .join()
          ]);
          return "";
        }
      });
      expect(selectors).toEqual([
        ["site/src/theme.css.ts", dependency, ".from-dependency"],
        ["src/theme.css.ts", filePath, ".from-entry"]
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
