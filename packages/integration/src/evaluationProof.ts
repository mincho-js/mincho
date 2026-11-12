import { parseSync, types as t } from "@babel/core";
import type { InternalSourceAstCache } from "@mincho-js/babel";
import { cacheDigest } from "./compilationInputs.js";
import {
  scopedFileScopeRuntime,
  validateCssScopeRuntimeOrigins,
  type CssScopeOrigin,
  type CssScopeRuntimeRegistration
} from "./fileScopeRuntime.js";

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
let commonJsFingerprint: string | undefined;
const commonJsSource = `(cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
}`;

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
  | {
      kind: "file-scope";
      method: "setFileScope" | "endFileScope";
      origin?: string;
    }
  | { kind: "helper" }
  | { kind: "scope-loader"; origin?: string }
  | { kind: "scope-bootstrap" };

/** A deliberately closed language. Failure always means fresh upstream evaluation. */
export function proveReusableEvaluation(
  source: string,
  cache?: InternalSourceAstCache,
  context?: { cssScopeOrigins: readonly CssScopeOrigin[] }
): { modules: string[] } | undefined {
  let registration: CssScopeRuntimeRegistration | undefined;
  try {
    registration = validateCssScopeRuntimeOrigins(
      source,
      context?.cssScopeOrigins
    );
  } catch {
    return undefined;
  }
  if (!cache) return analyzeReusableEvaluation(source, registration);

  const key = `evaluation-proof:${cacheDigest(JSON.stringify([source, registration?.key]))}`;
  const previous = cache.get<{ modules: string[] } | null>(key);
  if (previous !== undefined) return previous ?? undefined;

  const proof = analyzeReusableEvaluation(source, registration);

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

/** Scope attribution only, never VM reuse or general purity authority.
 * The caller must bind the returned module list to the same dependency snapshot
 * as its upstream evaluation. No result is cached across those evaluations.
 */
export function proveCssScopeOwnership(
  source: string,
  context: { cssScopeOrigins: readonly CssScopeOrigin[] }
):
  | {
      modules: string[];
      cssScopeOrigins: CssScopeOrigin[];
      registrationKey: string;
    }
  | undefined {
  try {
    const registration = validateCssScopeRuntimeOrigins(
      source,
      context.cssScopeOrigins
    );
    if (!registration) return;
    const scopes = new Map<string, CssScopeOrigin>();
    const proof = analyzeReusableEvaluation(source, registration, scopes);
    if (!proof) return;
    return {
      ...proof,
      cssScopeOrigins: [...scopes.values()],
      registrationKey: registration.key
    };
  } catch {
    return;
  }
}

function analyzeReusableEvaluation(
  source: string,
  registration?: CssScopeRuntimeRegistration,
  ownership?: Map<string, CssScopeOrigin>
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

    if (commonJsFingerprint === undefined) {
      const helper = parse(`(${commonJsSource});`).program.body[0];
      if (!t.isExpressionStatement(helper)) return undefined;
      commonJsFingerprint = canonical(helper.expression);
    }

    const program = parse(source).program;
    const bindings = new Map<string, Binding>();
    const helpers = new Set<string>();
    const modules = new Set<string>();
    let scopeDepth = 0;
    let activeScope: CssScopeOrigin | undefined;
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

    // This is only the exact compiler-emitted CJS facade acquisition. The
    // source-bound registration authenticates its factory/id; it does not make
    // any author function or arbitrary CommonJS module effect-free.
    const isRuntimeProxy = (node: t.Node | null | undefined): boolean => {
      if (
        !registration ||
        !t.isCallExpression(node) ||
        !t.isIdentifier(node.callee) ||
        bindings.get(node.callee.name)?.kind !== "scope-bootstrap" ||
        node.arguments.length !== 1 ||
        !t.isObjectExpression(node.arguments[0]) ||
        node.arguments[0].properties.length !== 1
      )
        return false;
      const method = node.arguments[0].properties[0];
      if (
        !t.isObjectMethod(method) ||
        !t.isStringLiteral(method.key) ||
        method.params.length !== 2 ||
        !method.params.every((p) => t.isIdentifier(p))
      )
        return false;
      const id = method.key.value.slice("mincho-css-scope-proxy:".length);
      if (
        method.key.value !== "mincho-css-scope-proxy:" + id ||
        !registration.origins.has(id)
      )
        return false;
      const first = method.body.body[0];
      if (
        !t.isVariableDeclaration(first) ||
        first.declarations.length !== 1 ||
        !t.isIdentifier(first.declarations[0].id)
      )
        return false;
      const original = first.declarations[0].id.name;
      const [exportsName, moduleName] = method.params as t.Identifier[];
      const locals = [exportsName.name, moduleName.name, original];
      if (
        new Set(locals).size !== locals.length ||
        locals.some(
          (name) => name === "require" || name === registration.factoryName
        )
      )
        return false;
      const expected = parse(`(${node.callee.name}({
        ${JSON.stringify(method.key.value)}(${exportsName.name}, ${moduleName.name}) {
          var ${original} = require("@vanilla-extract/css/fileScope");
          ${moduleName.name}.exports = typeof ${registration.factoryName} === "function"
            ? ${registration.factoryName}(${JSON.stringify(id)}) : ${original};
        }
      }));`).program.body[0];
      return (
        t.isExpressionStatement(expected) &&
        canonical(node) === canonical(expected.expression)
      );
    };
    const isScopeWrapper = (node: t.Node | null | undefined): boolean => {
      if (canonical(node) === fileScopeFingerprint) return true;
      if (
        !registration ||
        !t.isCallExpression(node) ||
        node.arguments.length !== 1
      )
        return false;
      const argument = node.arguments[0];
      if (
        !t.isCallExpression(argument) ||
        argument.arguments.length ||
        !t.isIdentifier(argument.callee) ||
        bindings.get(argument.callee.name)?.kind !== "scope-loader"
      )
        return false;
      const originalRequire = parse(
        'require("@vanilla-extract/css/fileScope");'
      ).program.body[0];
      if (!t.isExpressionStatement(originalRequire)) return false;
      const normalized = { ...node, arguments: [originalRequire.expression] };
      return canonical(normalized) === fileScopeFingerprint;
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
          registration &&
          t.isIdentifier(callee) &&
          bindings.get(callee.name)?.kind === "scope-loader" &&
          node.arguments.length === 0
        ) {
          if (ownership) return fail();
          modules.add("@vanilla-extract/css/fileScope");
          return {
            kind: "namespace",
            module: "@vanilla-extract/css/fileScope"
          };
        }

        if (
          t.isIdentifier(callee, { name: "require" }) &&
          node.arguments.length === 1 &&
          t.isStringLiteral(node.arguments[0])
        ) {
          const name = node.arguments[0].value;
          if (
            !Object.hasOwn(apis, name) ||
            (ownership && name === "@vanilla-extract/css/fileScope")
          )
            return fail();

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

        if (ownership && module === "@mincho-js/css" && method === "mincho$") {
          // The public build marker invokes its callback once. Analyze that
          // closed body, never treat an arbitrary function value as pure data.
          const callback = node.arguments[0];
          if (
            node.arguments.length !== 1 ||
            !(
              t.isArrowFunctionExpression(callback) ||
              t.isFunctionExpression(callback)
            ) ||
            callback.async ||
            callback.generator ||
            callback.params.length ||
            (t.isFunctionExpression(callback) && callback.id)
          )
            return fail();
          const body = t.isBlockStatement(callback.body)
            ? callback.body.body.length === 1 &&
              t.isReturnStatement(callback.body.body[0])
              ? callback.body.body[0].argument
              : undefined
            : callback.body;
          if (expression(body).kind !== "data") return fail();
          return { kind: "data" };
        }

        if (!module || !method || !apis[module].has(method)) return fail();

        for (const argument of node.arguments)
          if (expression(argument).kind !== "data") return fail();

        if (module === "@vanilla-extract/css/fileScope") {
          if (ownership) {
            if (binding?.kind !== "file-scope" || !binding.origin)
              return fail();
            if (method === "setFileScope") {
              const [file, name] = node.arguments;
              if (
                node.arguments.length < 1 ||
                node.arguments.length > 2 ||
                !t.isStringLiteral(file) ||
                (name !== undefined && !t.isStringLiteral(name)) ||
                // Upstream's CSS-text callback uses a delimited scope key.
                file.value.includes("$$$") ||
                name?.value.includes("$$$")
              )
                return fail();
              activeScope = {
                fileScope: {
                  filePath: file.value,
                  packageName: name?.value || undefined
                },
                origin: binding.origin
              };
            } else {
              if (
                node.arguments.length !== 0 ||
                activeScope?.origin !== binding.origin
              )
                return fail();
              activeScope = undefined;
            }
          }
          scopeDepth += method === "setFileScope" ? 1 : -1;

          if (scopeDepth < 0 || scopeDepth > 1) return fail();
        } else if (ownership) {
          // Known authoring APIs may emit CSS. A scope opened by an authenticated
          // proxy is mandatory even when a particular call happens to emit none.
          if (!activeScope) return fail();
          const key = JSON.stringify([
            activeScope.fileScope.filePath,
            activeScope.fileScope.packageName ?? null
          ]);
          const previous = ownership.get(key);
          if (previous && previous.origin !== activeScope.origin) return fail();
          ownership.set(key, activeScope);
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
              !isScopeWrapper(declaration.init)
            )
              return fail();

            let origin: string | undefined;
            if (ownership) {
              const wrapper = declaration.init;
              if (!t.isCallExpression(wrapper)) return fail();
              const acquisition = wrapper.arguments[0];
              if (
                !t.isCallExpression(acquisition) ||
                !t.isIdentifier(acquisition.callee)
              )
                return fail();
              const loader = bindings.get(acquisition.callee.name);
              if (loader?.kind !== "scope-loader" || !loader.origin)
                return fail();
              origin = loader.origin;
            }
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
                name === registration?.factoryName ||
                helperFingerprints.has(name)
              )
                return fail();

              methods.add(method);
              bindings.set(name, { kind: "file-scope", method, origin });
            }

            modules.add("@vanilla-extract/css/fileScope");
            continue;
          }

          if (
            !t.isIdentifier(declaration.id) ||
            bindings.has(declaration.id.name) ||
            reservedBindings.has(declaration.id.name) ||
            declaration.id.name === registration?.factoryName
          )
            return fail();

          const name = declaration.id.name;

          if (
            registration &&
            name === "__commonJS" &&
            canonical(declaration.init) === commonJsFingerprint
          ) {
            bindings.set(name, { kind: "scope-bootstrap" });
          } else if (isRuntimeProxy(declaration.init)) {
            // isRuntimeProxy authenticated this exact AST and registration ID.
            const call = declaration.init as t.CallExpression;
            const object = call.arguments[0] as t.ObjectExpression;
            const method = object.properties[0] as t.ObjectMethod;
            const id = (method.key as t.StringLiteral).value.slice(
              "mincho-css-scope-proxy:".length
            );
            bindings.set(name, {
              kind: "scope-loader",
              origin: registration!.origins.get(id)
            });
          } else if (
            helperFingerprints.get(name) === canonical(declaration.init)
          ) {
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
