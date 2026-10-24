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
  if (
    factory.source === "@mincho-js/css/rules/createRuntimeFn" &&
    ["createRuntimeFn", "createCompiledRuntimeFn"].includes(name)
  )
    return {
      full: true,
      compiled: name === "createCompiledRuntimeFn",
      packed: false
    };
  if (
    factory.source === "@mincho-js/css/rules/createClassRuntimeFn" &&
    name === "createCompiledClassRuntimeFn"
  )
    return { full: false, compiled: true, packed: false };
  for (const stem of ["Compact", "Packed", "PackedCompact"]) {
    if (factory.source !== `@mincho-js/css/rules/create${stem}RuntimeFn`)
      continue;
    if (
      [`create${stem}RuntimeFn`, `create${stem}ClassRuntimeFn`].includes(name)
    )
      return {
        full: name === `create${stem}RuntimeFn`,
        compiled: true,
        packed: stem.startsWith("Packed")
      };
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
