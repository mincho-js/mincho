import type { StaticCssEvalDiagnosticId } from "./types.js";

export type StaticCssEvalCjsGrammarContractStatus =
  | "accepted-static-grammar"
  | "rejected-static-grammar";

export interface StaticCssEvalCjsGrammarContractEntry {
  readonly construct: string;
  readonly grammar: string;
  readonly behavior: string;
  readonly status: StaticCssEvalCjsGrammarContractStatus;
  readonly diagnosticId?: StaticCssEvalDiagnosticId;
}

export interface StaticCssEvalCjsHelperRecognizerContractEntry {
  readonly helper: string;
  readonly acceptedWhen: string;
  readonly rejectedWhen: string;
  readonly diagnosticId: StaticCssEvalDiagnosticId;
}

// Todo 2 contract only: accepted grammar names future AST-recognizable shapes.
// Parser, binding collection, export maps, helper recognition, and resolver support
// remain fail-closed until their later todos wire these contracts into behavior.
export const STATIC_CSS_EVAL_CJS_GRAMMAR_CONTRACTS = [
  {
    construct: "Literal require namespace",
    grammar: 'const styles = require("./styles")',
    behavior: "Bind the effective CommonJS module value for member access",
    status: "accepted-static-grammar"
  },
  {
    construct: "Literal require member",
    grammar: 'const button = require("./styles").button',
    behavior:
      'Resolve member "button" from the effective CommonJS module value',
    status: "accepted-static-grammar"
  },
  {
    construct: "Shallow require destructure",
    grammar: 'const { button, card: cardStyle } = require("./styles")',
    behavior:
      "Resolve each local binding from the effective CommonJS module value",
    status: "accepted-static-grammar"
  },
  {
    construct: "Direct module value export",
    grammar: "module.exports = value",
    behavior: "Replace the effective CommonJS module value with a static value",
    status: "accepted-static-grammar"
  },
  {
    construct: "Named export property",
    grammar: "exports.button = value; module.exports.button = value",
    behavior:
      "Assign or override a named property when alias semantics are safe",
    status: "accepted-static-grammar"
  },
  {
    construct: "Default export property",
    grammar: "exports.default = value; module.exports.default = value",
    behavior:
      'Create the explicit "default" property without guessing ESM interop',
    status: "accepted-static-grammar"
  },
  {
    construct: "defineProperty value export",
    grammar: 'Object.defineProperty(exports, "button", { value })',
    behavior: "Use a static descriptor value as a named export",
    status: "accepted-static-grammar"
  },
  {
    construct: "defineProperty getter export",
    grammar:
      'Object.defineProperty(exports, "button", { get: function () { return value; } })',
    behavior:
      "Accept a getter only when it has one static identifier/member return",
    status: "accepted-static-grammar"
  },
  {
    construct: "Dynamic require",
    grammar: "require(expression)",
    behavior:
      "Reject runtime specifier resolution; no Node resolver or execution",
    status: "rejected-static-grammar",
    diagnosticId: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
  },
  {
    construct: "Unsupported CJS export mutation",
    grammar: "conditional exports.button = value; exports[dynamic] = value",
    behavior:
      "Reject export mutations that depend on runtime order or dynamic names",
    status: "rejected-static-grammar",
    diagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
  },
  {
    construct: "Unsupported helper",
    grammar: "helperName(exports, source)",
    behavior:
      "Reject helper calls unless a local side-effect-free AST fingerprint matches",
    status: "rejected-static-grammar",
    diagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  },
  {
    construct: "Full bundle runtime",
    grammar: "webpackBootstrap((modules) => runtimeRequire(id))",
    behavior:
      "Reject bundled module factories, chunk registries, and bootstrap requires",
    status: "rejected-static-grammar",
    diagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
  }
] as const satisfies readonly StaticCssEvalCjsGrammarContractEntry[];

export const STATIC_CSS_EVAL_CJS_HELPER_RECOGNIZER_CONTRACTS = [
  {
    helper: "TypeScript __createBinding",
    acceptedWhen:
      "A local helper definition matches the supported binding descriptor shape and the source came from a literal require",
    rejectedWhen:
      "The helper name appears without the local helper fingerprint or the source is not a literal require binding",
    diagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  },
  {
    helper: "TypeScript __exportStar",
    acceptedWhen:
      "A local helper definition matches the supported export-star loop and the source argument is a literal require",
    rejectedWhen:
      "The helper name appears without the local helper fingerprint or the source argument is dynamic",
    diagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  },
  {
    helper: "Babel/SWC defineProperty getter",
    acceptedWhen:
      "The descriptor target is exports, the export name is literal, and the getter returns exactly one static identifier/member",
    rejectedWhen:
      "The descriptor has a setter, spread, dynamic name, unknown key, or side-effectful getter body",
    diagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  },
  {
    helper: "esbuild __export + __toCommonJS",
    acceptedWhen:
      "Both local helper definitions match the known export-object fingerprint and getters return static values",
    rejectedWhen:
      "Either helper is name-only, user-defined with a different body, or wrapped in bundle runtime machinery",
    diagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  }
] as const satisfies readonly StaticCssEvalCjsHelperRecognizerContractEntry[];
