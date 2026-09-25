import { parseSync, types as t } from "@babel/core";
import type { InternalSourceAstCache } from "@mincho-js/babel";
import { cacheDigest } from "./compilationInputs.js";
import { scopedFileScopeRuntime } from "./fileScopeRuntime.js";

// Exact AST fingerprints, not helper names, establish the trusted esbuild glue.
const helperSource = `
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
`;

const canonical = (node: unknown): string =>
  JSON.stringify(node, (key, value) =>
    [
      "start",
      "end",
      "loc",
      "extra",
      "leadingComments",
      "trailingComments",
      "innerComments"
    ].includes(key)
      ? undefined
      : value
  );

let helperFingerprints: Map<string, string> | undefined;
let fileScopeFingerprint: string | undefined;

const apis: Readonly<Record<string, ReadonlySet<string>>> = {
  "@vanilla-extract/css": new Set([
    "style",
    "globalStyle",
    "styleVariants",
    "createVar",
    "fallbackVar",
    "assignVars",
    "createTheme",
    "createThemeContract",
    "createGlobalTheme",
    "createGlobalThemeContract",
    "keyframes",
    "globalKeyframes",
    "fontFace",
    "globalFontFace",
    "layer",
    "globalLayer",
    "createContainer"
  ]),
  "@vanilla-extract/css/fileScope": new Set(["setFileScope", "endFileScope"]),
  "@vanilla-extract/recipes": new Set(["recipe"]),
  "@vanilla-extract/sprinkles": new Set([
    "defineProperties",
    "createSprinkles"
  ]),
  "@mincho-js/css": new Set([
    "css",
    "globalCss",
    "rules",
    "theme",
    "globalTheme"
  ])
};

const forbiddenProperties = new Set(["__proto__", "prototype", "constructor"]);
const reservedBindings = new Set([
  "Object",
  "module",
  "exports",
  "require",
  "undefined"
]);

type Binding =
  | { kind: "data" }
  | { kind: "namespace"; module: string }
  | { kind: "file-scope"; method: "setFileScope" | "endFileScope" }
  | { kind: "helper" };

/** A deliberately closed language. Failure always means fresh upstream evaluation. */
export function proveReusableEvaluation(
  source: string,
  cache?: InternalSourceAstCache
): { modules: string[] } | undefined {
  if (!cache) return analyzeReusableEvaluation(source);

  const key = `evaluation-proof:${cacheDigest(source)}`;
  const previous = cache.get<{ modules: string[] } | null>(key);
  if (previous !== undefined) return previous ?? undefined;

  const proof = analyzeReusableEvaluation(source);

  if (proof) {
    Object.freeze(proof.modules);
    Object.freeze(proof);
  }

  cache.set(
    key,
    proof ?? null,
    Buffer.byteLength(JSON.stringify(proof ?? null))
  );

  return proof;
}

function analyzeReusableEvaluation(
  source: string
): { modules: string[] } | undefined {
  try {
    const parse = (code: string) =>
      parseSync(code, {
        configFile: false,
        babelrc: false,
        sourceType: "script"
      })!;

    helperFingerprints ??= new Map(
      parse(helperSource).program.body.flatMap((statement) =>
        t.isVariableDeclaration(statement)
          ? statement.declarations.map((declaration) => [
              (declaration.id as t.Identifier).name,
              canonical(declaration.init)
            ])
          : []
      )
    );

    if (fileScopeFingerprint === undefined) {
      const runtime = parse(scopedFileScopeRuntime).program.body[0];
      if (!t.isExpressionStatement(runtime)) return undefined;
      fileScopeFingerprint = canonical(runtime.expression);
    }

    const program = parse(source).program;
    const bindings = new Map<string, Binding>();
    const helpers = new Set<string>();
    const modules = new Set<string>();
    let scopeDepth = 0;
    const getters: string[] = [];

    const fail = (): never => {
      throw new Error("Unproved evaluation effect");
    };

    const property = (node: t.MemberExpression | t.ObjectProperty): string => {
      const key = t.isMemberExpression(node) ? node.property : node.key;
      const value =
        !node.computed && t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : undefined;
      if (value === undefined || forbiddenProperties.has(value)) return fail();

      return value;
    };

    const expression = (node: t.Node | null | undefined): Binding => {
      if (!node) return fail();
      if (
        t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node)
      )
        return { kind: "data" };

      if (t.isIdentifier(node)) {
        if (node.name === "undefined") return { kind: "data" };

        const binding = bindings.get(node.name);

        return binding ?? fail();
      }

      if (t.isObjectExpression(node)) {
        for (const entry of node.properties) {
          if (!t.isObjectProperty(entry)) return fail();

          property(entry);

          if (expression(entry.value).kind !== "data") return fail();
        }

        return { kind: "data" };
      }

      if (t.isArrayExpression(node)) {
        for (const value of node.elements)
          if (value && expression(value).kind !== "data") return fail();

        return { kind: "data" };
      }

      if (
        t.isUnaryExpression(node) &&
        ["void", "+", "-", "!", "~"].includes(node.operator)
      ) {
        if (expression(node.argument).kind !== "data") return fail();

        return { kind: "data" };
      }

      if (
        t.isMemberExpression(node) &&
        expression(node.object).kind === "data"
      ) {
        property(node);

        return { kind: "data" };
      }

      if (t.isCallExpression(node)) {
        let callee = node.callee;

        if (
          t.isSequenceExpression(callee) &&
          callee.expressions.length === 2 &&
          t.isNumericLiteral(callee.expressions[0], { value: 0 })
        )
          callee = callee.expressions[1];

        if (
          t.isIdentifier(callee, { name: "require" }) &&
          node.arguments.length === 1 &&
          t.isStringLiteral(node.arguments[0])
        ) {
          const name = node.arguments[0].value;
          if (!Object.hasOwn(apis, name)) return fail();

          modules.add(name);

          return { kind: "namespace", module: name };
        }

        if (
          t.isIdentifier(callee, { name: "__toCommonJS" }) &&
          bindings.get(callee.name)?.kind === "helper" &&
          node.arguments.length === 1
        ) {
          if (expression(node.arguments[0]).kind !== "data") return fail();

          return { kind: "data" };
        }

        const binding = t.isIdentifier(callee)
          ? bindings.get(callee.name)
          : t.isMemberExpression(callee)
            ? expression(callee.object)
            : undefined;
        const method =
          binding?.kind === "file-scope"
            ? binding.method
            : t.isMemberExpression(callee)
              ? property(callee)
              : undefined;
        const module =
          binding?.kind === "file-scope"
            ? "@vanilla-extract/css/fileScope"
            : binding?.kind === "namespace"
              ? binding.module
              : undefined;

        if (!module || !method || !apis[module].has(method)) return fail();

        for (const argument of node.arguments)
          if (expression(argument).kind !== "data") return fail();

        if (module === "@vanilla-extract/css/fileScope") {
          scopeDepth += method === "setFileScope" ? 1 : -1;

          if (scopeDepth < 0 || scopeDepth > 1) return fail();
        }

        return { kind: "data" };
      }

      return fail();
    };

    for (const statement of program.body) {
      if (t.isEmptyStatement(statement)) continue;

      if (t.isVariableDeclaration(statement)) {
        for (const declaration of statement.declarations) {
          if (t.isObjectPattern(declaration.id)) {
            if (
              declaration.id.properties.length !== 2 ||
              canonical(declaration.init) !== fileScopeFingerprint
            )
              return fail();

            const methods = new Set<string>();

            for (const entry of declaration.id.properties) {
              if (
                !t.isObjectProperty(entry) ||
                entry.computed ||
                !t.isIdentifier(entry.key) ||
                !t.isIdentifier(entry.value)
              )
                return fail();

              const method = entry.key.name;
              const name = entry.value.name;

              if (
                (method !== "setFileScope" && method !== "endFileScope") ||
                methods.has(method) ||
                bindings.has(name) ||
                reservedBindings.has(name) ||
                helperFingerprints.has(name)
              )
                return fail();

              methods.add(method);
              bindings.set(name, { kind: "file-scope", method });
            }

            modules.add("@vanilla-extract/css/fileScope");
            continue;
          }

          if (
            !t.isIdentifier(declaration.id) ||
            bindings.has(declaration.id.name) ||
            reservedBindings.has(declaration.id.name)
          )
            return fail();

          const name = declaration.id.name;

          if (helperFingerprints.get(name) === canonical(declaration.init)) {
            bindings.set(name, { kind: "helper" });
            helpers.add(name);
          } else {
            if (helperFingerprints.has(name)) return fail();

            bindings.set(name, expression(declaration.init));
          }
        }
      } else if (t.isExpressionStatement(statement)) {
        const node = statement.expression;
        if (
          t.isLogicalExpression(node, { operator: "&&" }) &&
          t.isNumericLiteral(node.left, { value: 0 })
        )
          continue;

        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "__export" }) &&
          bindings.get("__export")?.kind === "helper"
        ) {
          const [target, entries] = node.arguments;
          if (
            expression(target).kind !== "data" ||
            !t.isObjectExpression(entries) ||
            node.arguments.length !== 2
          )
            return fail();

          for (const entry of entries.properties) {
            if (
              !t.isObjectProperty(entry) ||
              !t.isArrowFunctionExpression(entry.value) ||
              entry.value.async ||
              entry.value.params.length ||
              !t.isIdentifier(entry.value.body)
            )
              return fail();

            property(entry);
            getters.push(entry.value.body.name);
          }
        } else if (
          t.isAssignmentExpression(node, { operator: "=" }) &&
          t.isMemberExpression(node.left) &&
          t.isIdentifier(node.left.object, { name: "module" }) &&
          property(node.left) === "exports"
        ) {
          if (expression(node.right).kind !== "data") return fail();
        } else expression(node);
      } else return fail();
    }

    // Helpers can refer forward to other helpers, but never to user replacements.
    if (helpers.size && helpers.size !== helperFingerprints.size) return fail();
    if (getters.some((name) => bindings.get(name)?.kind !== "data"))
      return fail();
    if (scopeDepth !== 0) return fail();

    return { modules: [...modules] };
  } catch {
    return undefined;
  }
}
