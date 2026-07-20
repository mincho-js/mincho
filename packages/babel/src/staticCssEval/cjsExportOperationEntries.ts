import { types as t } from "@babel/core";
import {
  createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic,
  createStaticCssEvalCjsExportUnsupportedDiagnostic,
  createStaticCssEvalCjsHelperUnsupportedDiagnostic
} from "./diagnostics.js";
import type {
  StaticCssEvalCjsExportMapOperation,
  StaticCssEvalCjsExportState
} from "./cjsExports.js";
import type { ExportMapEntry } from "./moduleCache.js";
import type {
  StaticCssEvalExportName,
  StaticCssEvalSourceLocation
} from "./types.js";

export function createExpressionSetOperation(
  exportName: StaticCssEvalExportName,
  expression: t.Expression,
  declaration: t.Statement
): StaticCssEvalCjsExportMapOperation {
  return createSetOperation({
    kind: "expression",
    exportName,
    expression,
    declaration
  });
}

export function createUnsupportedOperation(options: {
  readonly declaration: t.Statement;
  readonly exportName: StaticCssEvalExportName;
  readonly mutation: string;
  readonly node: t.Node;
  readonly state: StaticCssEvalCjsExportState;
}): StaticCssEvalCjsExportMapOperation {
  return createSetOperation({
    kind: "unsupported",
    exportName: options.exportName,
    unsupportedKind: "cjs-export",
    declaration: options.declaration,
    diagnostic: createStaticCssEvalCjsExportUnsupportedDiagnostic(
      {
        owner: createSourceLocation(options.state.file, options.node),
        exportName: options.exportName
      },
      options.mutation
    ),
    cjsExportMutation: options.mutation
  });
}

export function createHelperUnsupportedOperation(options: {
  readonly declaration: t.Statement;
  readonly exportName: StaticCssEvalExportName;
  readonly helperName: string;
  readonly node: t.Node;
  readonly state: StaticCssEvalCjsExportState;
}): StaticCssEvalCjsExportMapOperation {
  return createSetOperation({
    kind: "unsupported",
    exportName: options.exportName,
    unsupportedKind: "cjs-helper",
    declaration: options.declaration,
    diagnostic: createStaticCssEvalCjsHelperUnsupportedDiagnostic(
      {
        owner: createSourceLocation(options.state.file, options.node),
        exportName: options.exportName
      },
      options.helperName
    ),
    cjsHelperName: options.helperName
  });
}

export function createBundleRuntimeUnsupportedOperation(options: {
  readonly declaration: t.Statement;
  readonly node: t.Node;
  readonly runtimeName: string;
  readonly state: StaticCssEvalCjsExportState;
}): StaticCssEvalCjsExportMapOperation {
  return createSetOperation({
    kind: "unsupported",
    exportName: null,
    unsupportedKind: "cjs-bundle-runtime",
    declaration: options.declaration,
    diagnostic: createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic(
      {
        owner: createSourceLocation(options.state.file, options.node),
        exportName: null
      },
      options.runtimeName
    ),
    cjsBundleRuntimeName: options.runtimeName
  });
}

function createSetOperation(
  entry: ExportMapEntry
): StaticCssEvalCjsExportMapOperation {
  return { kind: "set", entry };
}

function createSourceLocation(
  file: string,
  node: t.Node
): StaticCssEvalSourceLocation {
  return {
    file,
    ...(typeof node.start === "number" ? { start: node.start } : {}),
    ...(typeof node.end === "number" ? { end: node.end } : {})
  };
}
