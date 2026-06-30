import { isUnSafeObjectKey } from "../utils.js";
import type {
  DefineRulesPropertyValuesEntries,
  DefineRulesPropertyValuesResult
} from "./types.js";

const DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC = "defineRules.propertyValues";

export function defineRulesPropertyValues<
  const Entries extends DefineRulesPropertyValuesEntries
>(entries: Entries): DefineRulesPropertyValuesResult<Entries> {
  if (!Array.isArray(entries)) {
    throw new Error(
      `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} expected entries array`
    );
  }

  const result = Object.create(null) as Record<string, unknown>;

  for (const entry of entries) {
    if (entry == null || typeof entry !== "object") {
      throw new Error(
        `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} expected entry object`
      );
    }

    if (!Object.prototype.hasOwnProperty.call(entry, "source")) {
      throw new Error(
        `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} missing source`
      );
    }

    if (!Object.prototype.hasOwnProperty.call(entry, "properties")) {
      throw new Error(
        `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} missing properties`
      );
    }

    const { source, properties } = entry;

    if (!Array.isArray(properties)) {
      throw new Error(
        `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} expected properties array`
      );
    }

    for (const property of properties) {
      const propertyKey = String(property);

      if (isUnSafeObjectKey(propertyKey)) {
        throw new Error(
          `${DEFINE_RULES_PROPERTY_VALUES_DIAGNOSTIC} unsupported property ${JSON.stringify(
            propertyKey
          )}`
        );
      }

      result[propertyKey] = source;
    }
  }

  return result as DefineRulesPropertyValuesResult<Entries>;
}
