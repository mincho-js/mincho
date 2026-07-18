import type { DefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";

const DEFINE_RULES_REGISTRY_SERIALIZABLE_CONFIG_DIAGNOSTIC =
  "defineRules registry serialization does not support function-valued conditions, properties, or shortcuts";
const DEFINE_RULES_REGISTRY_SERIALIZABLE_CONTEXT_DIAGNOSTIC =
  "defineRules registry serialization does not support non-serializable context";

export interface DefineRulesRegistryDiagnosticContext {
  fileScope: DefineRulesRegistrySession["instances"][number]["fileScope"];
  registrationIndex: number;
}

export function getConfigEntry(
  config: unknown,
  key: "conditions" | "context" | "properties" | "shortcuts"
): unknown {
  if (config == null || typeof config !== "object") {
    return undefined;
  }

  return (config as Record<string, unknown>)[key];
}

interface SerializableConfigEntryValidationOptions {
  validatePlainSerializableValues?: boolean;
}

export function validateSerializableConfigEntry(
  entry: unknown,
  path: string,
  diagnosticContext: DefineRulesRegistryDiagnosticContext,
  options: SerializableConfigEntryValidationOptions = {},
  seenEntries: WeakSet<object> = new WeakSet()
): void {
  if (
    entry == null ||
    typeof entry === "string" ||
    typeof entry === "number" ||
    typeof entry === "boolean" ||
    typeof entry === "undefined"
  ) {
    return;
  }

  if (typeof entry === "function") {
    throwSerializableConfigEntryDiagnostic(path, diagnosticContext, options);
  }

  if (
    options.validatePlainSerializableValues === true &&
    (typeof entry === "symbol" || typeof entry === "bigint")
  ) {
    throwSerializableConfigEntryDiagnostic(path, diagnosticContext, options);
  }

  if (typeof entry !== "object") {
    return;
  }

  if (seenEntries.has(entry)) {
    if (options.validatePlainSerializableValues === true) {
      throwSerializableConfigEntryDiagnostic(path, diagnosticContext, options);
    }
    return;
  }
  seenEntries.add(entry);

  try {
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        validateSerializableConfigEntry(
          entry[index],
          `${path}[${index}]`,
          diagnosticContext,
          options,
          seenEntries
        );
      }
      return;
    }

    if (
      options.validatePlainSerializableValues === true &&
      !isPlainSerializableConfigObject(entry)
    ) {
      throwSerializableConfigEntryDiagnostic(path, diagnosticContext, options);
    }

    for (const [key, value] of Object.entries(entry)) {
      validateSerializableConfigEntry(
        value,
        `${path}${formatConfigPathSegment(key)}`,
        diagnosticContext,
        options,
        seenEntries
      );
    }
  } finally {
    if (options.validatePlainSerializableValues === true) {
      seenEntries.delete(entry);
    }
  }
}

function throwSerializableConfigEntryDiagnostic(
  path: string,
  diagnosticContext: DefineRulesRegistryDiagnosticContext,
  options: SerializableConfigEntryValidationOptions
): never {
  const diagnosticMessage =
    options.validatePlainSerializableValues === true
      ? DEFINE_RULES_REGISTRY_SERIALIZABLE_CONTEXT_DIAGNOSTIC
      : DEFINE_RULES_REGISTRY_SERIALIZABLE_CONFIG_DIAGNOSTIC;

  throw new Error(
    `${diagnosticMessage} at ${path} (${formatDefineRulesRegistryDiagnosticContext(diagnosticContext)})`
  );
}

function formatDefineRulesRegistryDiagnosticContext(
  diagnosticContext: DefineRulesRegistryDiagnosticContext
): string {
  const packageName = diagnosticContext.fileScope.packageName ?? "<root>";

  return `fileScope: ${packageName}:${diagnosticContext.fileScope.filePath}, registrationIndex: ${diagnosticContext.registrationIndex}`;
}

function isPlainSerializableConfigObject(entry: object): boolean {
  const prototype = Object.getPrototypeOf(entry);

  return prototype === null || isObjectPrototype(prototype);
}

function isObjectPrototype(prototype: object): boolean {
  if (Object.getPrototypeOf(prototype) !== null) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(prototype, "constructor")) {
    return false;
  }

  const objectConstructor = (prototype as { constructor?: unknown })
    .constructor;

  return (
    typeof objectConstructor === "function" &&
    objectConstructor.prototype === prototype &&
    Function.prototype.toString.call(objectConstructor) ===
      Function.prototype.toString.call(Object)
  );
}

function formatConfigPathSegment(key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `.${key}`;
  }

  return `[${JSON.stringify(key)}]`;
}
