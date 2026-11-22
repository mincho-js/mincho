import {
  crossesWithEnvironment,
  runtimeParameterOffset
} from "./evaluation.js";
import { types as t, type NodePath } from "@babel/core";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type AuthoringArgumentPlan =
  | { kind: "parameter"; index: number }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "array"; elements: AuthoringArgumentPlan[] }
  | {
      kind: "object";
      entries: Array<
        | { kind: "property"; key: string; value: AuthoringArgumentPlan }
        | { kind: "spread"; value: AuthoringArgumentPlan }
      >;
    };

/** A conditional source summary, never a purity or module-initialization proof.
 * Callers must prove fresh closed actual inputs, preserve authoring effects and
 * ordering, and validate serialization before granting runtime recipe rights.
 */
export interface AuthoringCallContract {
  terminal: "style" | "recipe";
  parameterCount: number;
  /** Result may retain all reachable terminal argument data (recipe). */
  captures: "argument-graph" | "none";
  arguments: AuthoringArgumentPlan[];
  endpoint: { id: string; version: string; sourceHash: string };
}

/** Fixed, audited authoring endpoints; import spelling alone is not evidence. */
export function compilerAuthoringEndpoint(
  _source: string,
  name: string,
  resolvedId: string | null
): AuthoringCallContract["endpoint"] | undefined {
  // Hosts can rewrite a bare import to /@fs, file paths, or virtual IDs.
  // Select our audited registry by export name, not the request spelling; only
  // the resolved canonical file in this compiler installation grants authority.
  const source =
    name === "recipe"
      ? "@vanilla-extract/recipes"
      : name === "style"
        ? "@vanilla-extract/css"
        : undefined;
  const expected =
    name === "recipe" ? "0.5.7" : name === "style" ? "1.21.3" : undefined;
  if (!source || !expected || !resolvedId) return;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore CJS declaration generation does not support import.meta.
    const filename = createRequire(import.meta.url).resolve(source);
    for (let directory = dirname(filename); ; directory = dirname(directory)) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8")
        );
        if (pkg.name === source) {
          if (pkg.version !== expected) return;
          // Host module/browser conditions select other builds of this exact
          // compiler installation. Accept only published runtime root exports,
          // never a same-spelled package from another installation or an alias.
          const files = new Set([realpathSync(filename).replaceAll("\\", "/")]);
          const collect = (entry: unknown) => {
            if (typeof entry === "string" && entry.startsWith("./")) {
              files.add(
                realpathSync(resolve(directory, entry)).replaceAll("\\", "/")
              );
            } else if (
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry)
            ) {
              for (const [condition, target] of Object.entries(entry))
                if (
                  [
                    "module",
                    "default",
                    "browser",
                    "import",
                    "require"
                  ].includes(condition)
                )
                  collect(target);
            }
          };
          collect(pkg.exports?.["."]);
          if (!files.has(resolvedId)) return;
          return {
            id: resolvedId,
            version: pkg.version,
            sourceHash: createHash("sha256")
              .update(readFileSync(resolvedId))
              .digest("hex")
          };
        }
      } catch {
        /* Intermediate dist directories can have type-only manifests. */
      }
      if (dirname(directory) === directory) return;
    }
  } catch {
    return;
  }
}

/** Serialize only effect-free argument construction syntax, without evaluating it.
 * Callers first establish a dynamic-scope-free wrapper with a single terminal
 * call, so parameter reads cannot follow reassignment through eval or arguments. */
export function authoringArgumentPlan(
  path: NodePath<t.Node>,
  parameters: readonly NodePath<t.Identifier>[],
  budget = { remaining: 256 }
): AuthoringArgumentPlan | undefined {
  if (--budget.remaining < 0) return;
  if (path.isIdentifier()) {
    if (crossesWithEnvironment(path)) return;
    const binding = path.scope.getBinding(path.node.name);
    const offset = runtimeParameterOffset(
      parameters.map((parameter) => parameter.node)
    );
    if (offset === undefined) return;
    const index = parameters
      .slice(offset)
      .findIndex(
        (parameter) =>
          parameter.scope.getBinding(parameter.node.name) === binding
      );
    return index < 0 || !binding?.constant
      ? undefined
      : { kind: "parameter", index };
  }
  if (
    path.isStringLiteral() ||
    path.isBooleanLiteral() ||
    path.isNullLiteral() ||
    (path.isNumericLiteral() && Number.isFinite(path.node.value))
  )
    return {
      kind: "literal",
      value: path.isNullLiteral()
        ? null
        : (path.node as t.StringLiteral | t.BooleanLiteral | t.NumericLiteral)
            .value
    };
  if (path.isObjectExpression()) {
    const entries: Extract<
      AuthoringArgumentPlan,
      { kind: "object" }
    >["entries"] = [];
    for (const property of path.get("properties")) {
      if (property.isSpreadElement()) {
        const value = authoringArgumentPlan(
          property.get("argument"),
          parameters,
          budget
        );
        if (!value) return;
        entries.push({ kind: "spread", value });
      } else if (property.isObjectProperty() && !property.node.computed) {
        const key = t.isIdentifier(property.node.key)
          ? property.node.key.name
          : t.isStringLiteral(property.node.key)
            ? property.node.key.value
            : undefined;
        if (key === undefined || key === "__proto__") return;
        const value = authoringArgumentPlan(
          property.get("value"),
          parameters,
          budget
        );
        if (!value) return;
        entries.push({ kind: "property", key, value });
      } else return;
    }
    return { kind: "object", entries };
  }
  if (path.isArrayExpression()) {
    const elements: AuthoringArgumentPlan[] = [];
    for (const element of path.get("elements")) {
      if (!element.node) return;
      const value = authoringArgumentPlan(
        element as NodePath<t.Node>,
        parameters,
        budget
      );
      if (!value) return;
      elements.push(value);
    }
    return { kind: "array", elements };
  }
}

export function substituteAuthoringPlan(
  plan: AuthoringArgumentPlan,
  arguments_: readonly AuthoringArgumentPlan[]
): AuthoringArgumentPlan | undefined {
  if (plan.kind === "parameter") return arguments_[plan.index];
  if (plan.kind === "literal") return plan;
  if (plan.kind === "array") {
    const elements = plan.elements.map((value) =>
      substituteAuthoringPlan(value, arguments_)
    );
    return elements.every((value) => value !== undefined)
      ? { kind: "array", elements }
      : undefined;
  }
  const entries: Extract<AuthoringArgumentPlan, { kind: "object" }>["entries"] =
    [];
  for (const entry of plan.entries) {
    const value = substituteAuthoringPlan(entry.value, arguments_);
    if (!value) return;
    entries.push({ ...entry, value });
  }
  return { kind: "object", entries };
}
