import { throwInvalid } from "./presetArtifactReaders.js";

export function assertDefineRulesPresetVersionV5(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return;
  const schemaDescriptor = Object.getOwnPropertyDescriptor(value, "schema");

  if (schemaDescriptor !== undefined && !("value" in schemaDescriptor)) return;
  if (schemaDescriptor?.value !== "mincho.defineRulesPreset") {
    throwInvalid("$.schema", "expected defineRules preset schema");
  }

  const versionDescriptor = Object.getOwnPropertyDescriptor(value, "version");

  if (
    versionDescriptor === undefined ||
    ("value" in versionDescriptor && versionDescriptor.value !== 5)
  ) {
    throwInvalid("$.version", "expected defineRules preset version 5");
  }
}
