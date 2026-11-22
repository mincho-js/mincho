import { InternalSourceAstCache } from "@mincho-js/babel";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  proveCssScopeOwnership,
  proveReusableEvaluation
} from "./evaluationProof.js";
import { issueCssScopeRuntimeOrigins } from "./fileScopeRuntime.js";

const filePath = join(process.cwd(), "src/__fixtures__/scope-proof.css.ts");

describe("attested compiler scope effect proof", () => {
  it("keeps the exact compiled facade reusable only with current issued evidence", async () => {
    const result = await compile({
      filePath,
      originalPath: filePath,
      contents:
        'import {style} from "@vanilla-extract/css";export const box=style({color:"red"});',
      resolverCache: new Map()
    });
    const context = { cssScopeOrigins: result.cssScopeOrigins };
    const parser = new InternalSourceAstCache(() => {});
    expect(proveReusableEvaluation(result.source, parser)).toBeUndefined();
    expect(
      proveReusableEvaluation(result.source, parser, context)
    ).toBeDefined();
    expect(proveReusableEvaluation(result.source, parser)).toBeUndefined();
    expect(result.cssScopeOrigins.some((entry) => entry.runtime)).toBe(true);
    expect(proveReusableEvaluation(result.source)).toBeUndefined();
    expect(
      proveReusableEvaluation(result.source, undefined, context)?.modules
    ).toContain("@vanilla-extract/css/fileScope");
    expect(
      proveReusableEvaluation(result.source, undefined, {
        cssScopeOrigins: structuredClone(result.cssScopeOrigins)
      })
    ).toBeUndefined();
    expect(
      proveReusableEvaluation(result.source + "\n", undefined, context)
    ).toBeUndefined();

    for (const source of [
      result.source.replace(
        "typeof __mincho_css_scope_factory_",
        "typeof unrelated_"
      ),
      result.source.replace(
        "var original = require(",
        "globalThis.changed = true; var original = require("
      ),
      result.source.replace(
        "return mod ||",
        "globalThis.changed = true; return mod ||"
      ),
      result.source + "\nunknownFactory();",
      result.source.replace(" : original;", " : unknownFactory();")
    ]) {
      expect(source).not.toBe(result.source);
      // Even an issued registration is not blanket authority for other effects.
      expect(
        proveReusableEvaluation(source, undefined, {
          cssScopeOrigins: issueCssScopeRuntimeOrigins(
            source,
            result.cssScopeOrigins
          )
        })
      ).toBeUndefined();
    }
  });
});

describe("closed upstream scope ownership", () => {
  it("derives literal scopes from authenticated proxy origins, not mutable hints", async () => {
    const result = await compile({
      filePath,
      originalPath: filePath,
      contents:
        'import {style} from "@vanilla-extract/css";export const box=style({color:"red"});',
      resolverCache: new Map()
    });
    const context = { cssScopeOrigins: result.cssScopeOrigins };
    const proof = proveCssScopeOwnership(result.source, context);
    expect(proof?.cssScopeOrigins).toEqual([
      {
        fileScope: {
          filePath: "src/__fixtures__/scope-proof.css.ts",
          packageName: "@mincho-js/integration"
        },
        origin: filePath
      }
    ]);
    expect(proof?.modules).toContain("@vanilla-extract/css");
    for (const entry of result.cssScopeOrigins)
      Object.assign(entry.fileScope, { filePath: "misleading-hint.css.ts" });
    expect(proveCssScopeOwnership(result.source, context)).toEqual(proof);
    expect(
      proveCssScopeOwnership(result.source, {
        cssScopeOrigins: structuredClone(result.cssScopeOrigins)
      })
    ).toBeUndefined();
    expect(
      proveCssScopeOwnership(result.source + ";", context)
    ).toBeUndefined();
  });
  it.each([
    'require("@vanilla-extract/css/fileScope");',
    'const scope=require("@vanilla-extract/css/fileScope");scope.setFileScope("forged.css.ts","pkg");',
    'const path="@vanilla-extract/css/fileScope";require(path);',
    "unknownFactory();",
    "globalThis.changed=true;"
  ])("never treats unclosed operations as ownership: %s", async (extra) => {
    const result = await compile({
      filePath,
      originalPath: filePath,
      contents:
        'import {style} from "@vanilla-extract/css";export const box=style({color:"red"});',
      resolverCache: new Map()
    });
    const source = result.source + ";" + extra;
    const context = {
      cssScopeOrigins: issueCssScopeRuntimeOrigins(
        source,
        result.cssScopeOrigins
      )
    };
    expect(proveCssScopeOwnership(source, context)).toBeUndefined();
  });
});

it("requires literal balanced scope calls even with freshly issued source evidence", async () => {
  const result = await compile({
    filePath,
    originalPath: filePath,
    contents:
      'import {style} from "@vanilla-extract/css";export const box=style({color:"red"});',
    resolverCache: new Map()
  });
  for (const source of [
    result.source.replace(
      'setFileScope("src/__fixtures__/scope-proof.css.ts",',
      'setFileScope(["src/__fixtures__/scope-proof.css.ts"][0],'
    ),
    result.source.replace("endFileScope();", ""),
    result.source + ";module.exports.scope=setFileScope;"
  ]) {
    expect(source).not.toBe(result.source);
    expect(
      proveCssScopeOwnership(source, {
        cssScopeOrigins: issueCssScopeRuntimeOrigins(
          source,
          result.cssScopeOrigins
        )
      })
    ).toBeUndefined();
  }
  const manual = result.source.replace(
    'setFileScope("src/__fixtures__/scope-proof.css.ts",',
    'setFileScope("manual.css.ts",'
  );
  const proof = proveCssScopeOwnership(manual, {
    cssScopeOrigins: issueCssScopeRuntimeOrigins(manual, result.cssScopeOrigins)
  });
  expect(proof?.cssScopeOrigins[0]).toMatchObject({
    fileScope: { filePath: "manual.css.ts" },
    origin: filePath
  });
  for (const delimited of [
    manual.replace('"manual.css.ts"', () => '"manual$$$dark.css.ts"'),
    manual.replace('"@mincho-js/integration"', () => '"package$$$variant"')
  ]) {
    expect(delimited).not.toBe(manual);
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(
      delimited,
      result.cssScopeOrigins
    );
    expect(
      proveReusableEvaluation(delimited, undefined, { cssScopeOrigins })
    ).toBeDefined();
    expect(
      proveCssScopeOwnership(delimited, { cssScopeOrigins })
    ).toBeUndefined();
  }
});

describe("closed build-marker ownership callbacks", () => {
  it.each([
    "()=>[red,blue]",
    "()=>{return [red,blue]}",
    "function(){return [red,blue]}"
  ])(
    "preserves ownership through %s without granting VM reuse",
    async (callback) => {
      const result = await compile({
        filePath,
        originalPath: filePath,
        contents: `import {style} from '@vanilla-extract/css';import {mincho$} from '@mincho-js/css';const red=style({color:'red'}),blue=style({color:'blue'});export const classes=mincho$(${callback});`,
        resolverCache: new Map()
      });
      const context = { cssScopeOrigins: result.cssScopeOrigins };
      expect(
        proveCssScopeOwnership(result.source, context)?.cssScopeOrigins
      ).toEqual([
        {
          fileScope: {
            filePath: "src/__fixtures__/scope-proof.css.ts",
            packageName: "@mincho-js/integration"
          },
          origin: filePath
        }
      ]);
      expect(
        proveReusableEvaluation(result.source, undefined, context)
      ).toBeUndefined();
    }
  );
  it.each([
    "()=>unknown()",
    "async()=>[red]",
    "(value)=>[value]",
    "()=>{globalThis.changed=true;return [red]}",
    "()=>()=>red",
    "function named(){return [red]}"
  ])("does not authorize arbitrary marker callbacks: %s", async (callback) => {
    const result = await compile({
      filePath,
      originalPath: filePath,
      contents: `import {style} from '@vanilla-extract/css';import {mincho$} from '@mincho-js/css';const red=style({color:'red'});export const classes=mincho$(${callback});`,
      resolverCache: new Map()
    });
    expect(
      proveCssScopeOwnership(result.source, {
        cssScopeOrigins: result.cssScopeOrigins
      })
    ).toBeUndefined();
  });
});
