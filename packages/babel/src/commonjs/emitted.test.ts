import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { commonJsToEsmPlugin, inspectCommonJs } from "./esm.js";
import { inspectEmittedCommonJs } from "./emitted.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow,
  type ModuleGraphResponse
} from "../moduleGraph.js";

function converted(source: string) {
  const description = inspectCommonJs(source, "/helper.cjs");
  return transformSync(source, {
    filename: "/helper.cjs",
    configFile: false,
    babelrc: false,
    plugins: [
      commonJsToEsmPlugin({
        description,
        imports: Object.fromEntries(
          description.requires.map((id) => [id, { id, commonjs: false }])
        ),
        exportNames: description.exports
      })
    ]
  })!.code!;
}

function graphFor(
  source: string,
  receipt: boolean,
  dependencies: Record<string, string> = {}
) {
  const files: Record<string, string> = {
    "/helper.cjs": source,
    "/compiled.css.ts": 'export const token = "compiled-class";',
    ...dependencies
  };
  const graph = createModuleGraph({ loadPurpose: "consumer-runtime" });
  const run = <T>(flow: ModuleGraphFlow<T>): T => {
    let step = flow.next();
    while (!step.done) {
      const request = step.value;
      let value: ModuleGraphResponse = null;
      if (request.kind === "resolve")
        value = resolve(dirname(request.importer), request.source);
      else if (request.kind === "load" && files[request.id] !== undefined) {
        const code = files[request.id]!;
        value = receipt
          ? {
              source: code,
              sourceHash: createHash("sha256").update(code).digest("hex"),
              version: "host-1",
              watchFiles: [request.id]
            }
          : code;
      }
      step = flow.next(value);
    }
    return step.value;
  };
  return { graph, run };
}

describe("host-emitted CommonJS publications", () => {
  it("follows converter publications with ordinary dependency initialization", () => {
    const source = converted(
      'const {token} = require("./compiled.css.ts"); exports.className = token; exports.create = () => token;'
    );
    const { graph, run } = graphFor(source, true);
    const module = run(graph.load("/helper.cjs"));
    const target = run(graph.resolveExport(module, "className", new Set()));
    expect(target && !("external" in target) && target.path.node).toMatchObject(
      {
        type: "StringLiteral",
        value: "compiled-class"
      }
    );
    expect(
      run(graph.objectExportOrigins("/helper.cjs")).unknownExports ?? []
    ).not.toContain('["className"]');
  });

  it("keeps ordinary dependency effects separate from prototype mutation", () => {
    const source = converted(
      'require("./setup.js"); exports.className = "compiled-class";'
    );
    const { graph, run } = graphFor(source, true, {
      "/setup.js": "globalThis.cssReady = true;"
    });
    const module = run(graph.load("/helper.cjs"));
    const target = run(graph.resolveExport(module, "className", new Set()));
    expect(target && !("external" in target) && target.path.node).toMatchObject(
      {
        type: "StringLiteral",
        value: "compiled-class"
      }
    );
  });

  it("does not confer host provenance on the same authoring bytes", () => {
    const source = converted('exports.className = "compiled-class";');
    const { graph, run } = graphFor(source, false);
    expect(
      run(graph.objectExportOrigins("/helper.cjs")).unknownExports
    ).toContain('["className"]');
  });

  function wrapper(before = "", after = "") {
    return `var box = { exports: {} }, out = box.exports;
      out.className = "class";
      ${before}
      const snapshot = box.exports;
      ${after}
      export default snapshot;
      const projected = snapshot["className"];
      export { projected as className };`;
  }

  it("uses binding identity independently of emitter names", () => {
    expect(
      inspectEmittedCommonJs(
        parseModuleProgram("/host.js", wrapper()),
        "/host.js"
      )?.exports.has("className")
    ).toBe(true);
  });

  it("does not certify an assignment intercepted by an inherited setter", () => {
    const source = wrapper().replace(
      'out.className = "class";',
      `Object.defineProperty(Object.prototype, "className", {
        configurable: true, set(value) {}
      });
      out.className = "class";`
    );

    expect(
      inspectEmittedCommonJs(parseModuleProgram("/host.js", source), "/host.js")
    ).toBeUndefined();
    const { graph, run } = graphFor(source, true);
    const module = run(graph.load("/helper.cjs"));
    const target = run(graph.resolveExport(module, "className", new Set()));
    expect(
      target && !("external" in target) && target.path.node
    ).not.toMatchObject({
      type: "StringLiteral",
      value: "class"
    });
    const origins = run(graph.objectExportOrigins("/helper.cjs"));
    expect(origins.unknownExports).toContain('["className"]');
    expect(origins.ownDataPaths ?? []).not.toContain('["className"]');
  });

  it("withdraws publication recovery for observed graph prototype mutation", () => {
    const source = 'import "./mutator.js";\n' + wrapper();
    const { graph, run } = graphFor(source, true, {
      "/mutator.js":
        'Object.defineProperty(Object.prototype, "className", { configurable: true, set(value) {} });'
    });
    run(graph.load("/mutator.js"));
    const origins = run(graph.objectExportOrigins("/helper.cjs"));

    expect(origins.unknownExports).toContain('["className"]');
    expect(origins.ownDataPaths ?? []).not.toContain('["className"]');
  });

  it("withdraws cached publication recovery when a later module mutates prototypes", () => {
    const { graph, run } = graphFor(wrapper(), true, {
      "/mutator.js": 'Object.prototype.className = "changed";'
    });
    expect(
      run(graph.objectExportOrigins("/helper.cjs")).ownDataPaths
    ).toContain('["className"]');

    run(graph.load("/mutator.js"));
    const origins = run(graph.objectExportOrigins("/helper.cjs"));

    expect(origins.unknownExports).toContain('["className"]');
    expect(origins.ownDataPaths ?? []).not.toContain('["className"]');
  });

  it("does not mix unrelated global CommonJS helpers into the private publication map", () => {
    const source = wrapper(
      'Object.defineProperty(exports, "className", { value: "other" });'
    );
    const entry = inspectEmittedCommonJs(
      parseModuleProgram("/host.js", source),
      "/host.js"
    )?.exports.get("className");
    expect(entry?.kind === "expression" && entry.expression).toMatchObject({
      type: "StringLiteral",
      value: "class"
    });
  });

  it.each([
    ["alias escape", "opaque(out);", ""],
    ["module escape", "opaque(box);", ""],
    ["captured alias", "function later() { return out; }", ""],
    ["reassignment", "out = {};", ""],
    [
      "descriptor write",
      'Object.defineProperty(out, "className", { get() { return "changed"; } });',
      ""
    ],
    [
      "module getter",
      'Object.defineProperty(box, "exports", { get() { return {}; } });',
      ""
    ],
    ["computed write", 'out[key] = "changed";', ""],
    ["nested write", 'out.className.value = "changed";', ""],
    ["update", "out.className++;", ""],
    ["delete", "delete out.className;", ""],
    ["prototype write", "out.__proto__ = null;", ""],
    ["dynamic scope", 'eval("out.className = 1");', ""],
    ["late write", "", 'out.className = "changed";'],
    ["snapshot escape", "", "opaque(snapshot);"]
  ])(
    "rejects %s instead of inferring an immutable export",
    (_name, before, after) => {
      expect(
        inspectEmittedCommonJs(
          parseModuleProgram("/host.js", wrapper(before, after)),
          "/host.js"
        )
      ).toBeUndefined();
    }
  );
});
