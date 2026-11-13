export const recipeRuntimeFactories = [
  {
    source: "@mincho-js/css/rules/createRuntimeFn",
    name: "createRuntimeFn",
    full: true,
    compiled: false,
    packed: false
  },
  {
    source: "@mincho-js/css/rules/createRuntimeFn",
    name: "createCompiledRuntimeFn",
    full: true,
    compiled: true,
    packed: false
  },
  {
    source: "@mincho-js/css/rules/createClassRuntimeFn",
    name: "createCompiledClassRuntimeFn",
    full: false,
    compiled: true,
    packed: false
  },
  ...["Compact", "Packed", "PackedCompact"].flatMap((stem) =>
    [false, true].map((classOnly) => ({
      source: `@mincho-js/css/rules/create${stem}RuntimeFn`,
      name: `create${stem}${classOnly ? "Class" : ""}RuntimeFn`,
      full: !classOnly,
      compiled: true,
      packed: stem.startsWith("Packed")
    }))
  )
];

export function recipeFactoryKind(
  factory:
    | { source: string; members: readonly (string | null)[]; unsafe?: string }
    | null
    | undefined
) {
  if (
    !factory ||
    factory.unsafe ||
    factory.members.some((member) => member === null)
  )
    return;
  const name = factory.members.join(".");
  const match = recipeRuntimeFactories.find(
    (entry) => entry.source === factory.source && entry.name === name
  );
  if (!match) return;
  const { full, compiled, packed } = match;
  return { full, compiled, packed };
}

const compilerFactoryFiles = new Map<string, ReadonlySet<string>>();
const closedRuntimeFactories = [
  ...recipeRuntimeFactories,
  {
    source: "@vanilla-extract/recipes/createRuntimeFn",
    name: "createRuntimeFn",
    full: false,
    compiled: true,
    packed: false
  }
];

/** Resolve the compiler's own dependency, not a host alias with its spelling. */
export function compilerRecipeFactoryFiles(
  source: string
): ReadonlySet<string> {
  const cached = compilerFactoryFiles.get(source);
  if (cached) return cached;
  const files = new Set<string>();
  compilerFactoryFiles.set(source, files);
  if (!closedRuntimeFactories.some((entry) => entry.source === source))
    return files;
  const packageName = source.split("/").slice(0, 2).join("/");
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore CJS declaration generation does not support import.meta.
    const required = createRequire(import.meta.url).resolve(source);
    for (let directory = dirname(required); ; directory = dirname(directory)) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8")
        );
        if (manifest.name === packageName) {
          const exported = manifest.exports?.[source.replace(packageName, ".")];
          for (const mode of ["import", "require"] as const) {
            const target =
              exported?.[mode] ??
              (mode === "import" ? exported?.module : undefined) ??
              exported?.default;
            const filename =
              typeof target === "string" ? target : target?.default;
            if (typeof filename === "string")
              files.add(
                realpathSync(resolve(directory, filename)).replaceAll("\\", "/")
              );
          }
          break;
        }
      } catch {
        /* A dist directory can have a type-only package manifest. */
      }
      if (dirname(directory) === directory) break;
    }
  } catch {
    /* An unavailable compiler dependency cannot establish its runtime ABI. */
  }
  return files;
}

/** A compiled factory over private data allocates a fresh callable, not a data shape. */
export function isClosedCompiledRecipeAllocation(
  call: t.CallExpression,
  reference: {
    source: string;
    members: readonly (string | null)[];
    unsafe?: string;
  },
  resolvedId: string | null
): boolean {
  if (
    !resolvedId ||
    reference.unsafe ||
    reference.members.some((member) => member === null)
  )
    return false;
  // Hosts can rewrite import spellings. The compiler-owned file and exported
  // endpoint establish the ABI; the spelling alone does not.
  const name = reference.members.join(".");
  const factory = closedRuntimeFactories.find(
    (entry) =>
      entry.compiled &&
      entry.name === name &&
      compilerRecipeFactoryFiles(entry.source).has(resolvedId)
  );
  if (
    !factory ||
    call.optional ||
    call.arguments.length < 1 ||
    call.arguments.length > (factory.full ? 3 : 2)
  )
    return false;
  try {
    const args = call.arguments.map((argument) => {
      if (!t.isExpression(argument)) throw new Error("Unknown recipe argument");
      return readRecipeData(argument);
    });
    const config = factory.packed ? decodeRecipePayload(args[0]) : args[0];
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const strings = (value: unknown) =>
      record(value) &&
      Object.values(value).every((entry) => typeof entry === "string");
    const selections = (value: unknown) =>
      record(value) &&
      Object.values(value).every(
        (entry) =>
          entry == null ||
          ["string", "number", "boolean"].includes(typeof entry)
      );
    const groups = (value: unknown) =>
      record(value) && Object.values(value).every(strings);
    if (
      !record(config) ||
      Object.keys(config).some(
        (key) =>
          ![
            "defaultClassName",
            "variantClassNames",
            "defaultVariants",
            "compoundVariants",
            "classNameReferences",
            "extension"
          ].includes(key)
      ) ||
      typeof config.defaultClassName !== "string" ||
      !groups(config.variantClassNames) ||
      !selections(config.defaultVariants) ||
      !Array.isArray(config.compoundVariants) ||
      !config.compoundVariants.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          selections(entry[0]) &&
          typeof entry[1] === "string"
      )
    )
      return false;
    if (config.classNameReferences !== undefined) {
      const names = config.classNameReferences;
      if (
        !record(names) ||
        typeof names.base !== "string" ||
        !groups(names.variants)
      )
        return false;
    }
    if (config.extension !== undefined) {
      const extension = config.extension;
      if (
        !record(extension) ||
        extension.version !== 1 ||
        Object.keys(extension).some(
          (key) => key !== "version" && key !== "stylePackages"
        ) ||
        !Array.isArray(extension.stylePackages) ||
        !extension.stylePackages.every((value) => typeof value === "string")
      )
        return false;
    }
    if (factory.full && args[1] !== undefined && !strings(args[1]))
      return false;
    const features = args[factory.full ? 2 : 1];
    return (
      features === undefined ||
      (record(features) &&
        Object.entries(features).every(
          ([key, value]) =>
            [
              "variants",
              "classNames",
              ...(factory.full ? ["props"] : [])
            ].includes(key) && typeof value === "boolean"
        ))
    );
  } catch {
    return false;
  }
}

/** Decode only validated compiler data, with a finite budget and no user calls. */
export function decodeRecipePayload(payload: unknown): unknown {
  if (
    !Array.isArray(payload) ||
    payload.length !== 3 ||
    payload[0] !== 1 ||
    !Array.isArray(payload[1]) ||
    !payload[1].every((value) => typeof value === "string")
  )
    throw new Error("Unknown recipe payload");
  const strings = payload[1] as string[];
  let budget = 10000;
  const string = (index: unknown) => {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= strings.length
    )
      throw new Error("Invalid string index");
    return strings[index]!;
  };
  const decode = (value: unknown): unknown => {
    if (--budget < 0) throw new Error("Recipe payload budget");
    if (!Array.isArray(value)) {
      if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        return value;
      throw new Error("Invalid scalar");
    }
    if (value[0] === "u" && value.length === 1) return undefined;
    if (value[0] === "s" && value.length === 2) return string(value[1]);
    if (value[0] === "a" && value.length === 2 && Array.isArray(value[1]))
      return value[1].map(decode);
    if (value[0] === "o" && value.length === 2 && Array.isArray(value[1])) {
      const names = new Set<string>();
      return Object.fromEntries(
        value[1].map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2)
            throw new Error("Invalid pair");
          const name = string(entry[0]);
          if (name === "__proto__" || names.has(name))
            throw new Error("Invalid key");
          names.add(name);
          return [name, decode(entry[1])];
        })
      );
    }
    throw new Error("Unknown recipe tag");
  };
  return decode(payload[2]);
}
import { types as t } from "@babel/core";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

export type RecipeData =
  | undefined
  | null
  | string
  | number
  | boolean
  | RecipeData[]
  | { [key: string]: RecipeData };

/** Read closed compiler data without evaluating names, accessors or calls. */
export function readRecipeData(node: t.Expression): RecipeData {
  let budget = 10000;
  const read = (node: t.Expression): RecipeData => {
    if (--budget < 0) throw new Error("Recipe data budget");
    if (
      t.isUnaryExpression(node, { operator: "void" }) &&
      t.isNumericLiteral(node.argument)
    )
      return undefined;
    if (
      t.isStringLiteral(node) ||
      t.isBooleanLiteral(node) ||
      (t.isNumericLiteral(node) && Number.isFinite(node.value))
    )
      return node.value;
    if (
      t.isUnaryExpression(node) &&
      (node.operator === "+" || node.operator === "-") &&
      t.isNumericLiteral(node.argument) &&
      Number.isFinite(node.argument.value)
    )
      return node.operator === "-" ? -node.argument.value : node.argument.value;
    if (t.isNullLiteral(node)) return null;
    if (t.isArrayExpression(node))
      return node.elements.map((item) => {
        if (!item || !t.isExpression(item)) throw new Error("Non-static array");
        return read(item);
      });
    if (t.isObjectExpression(node)) {
      const result: Record<string, RecipeData> = Object.create(null);
      for (const property of node.properties) {
        if (
          !t.isObjectProperty(property) ||
          (property.computed && t.isIdentifier(property.key)) ||
          !t.isExpression(property.value)
        )
          throw new Error("Non-static object");
        const key = t.isIdentifier(property.key)
          ? property.key.name
          : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
            ? String(property.key.value)
            : null;
        if (key === null || key === "prototype" || key in Object.prototype)
          throw new Error("Unsupported key");
        result[key] = read(property.value);
      }
      return result;
    }
    throw new Error("Non-static value");
  };
  return read(node);
}
