/** Versioned private compiler payload; never applied to caller-owned objects. */
export type PackedRecipeValue =
  | null
  | boolean
  | number
  | ["s", number]
  | ["a", PackedRecipeValue[]]
  | ["o", [number, PackedRecipeValue][]]
  | ["u"];
export type PackedRecipe = [1, string[], PackedRecipeValue];

export function unpackRecipe([version, strings, value]: PackedRecipe): unknown {
  if (version !== 1)
    throw new Error("Unsupported Mincho recipe payload version.");
  const read = (item: PackedRecipeValue): unknown => {
    if (!Array.isArray(item)) return item;
    switch (item[0]) {
      case "s":
        return strings[item[1]];
      case "u":
        return undefined;
      case "a":
        return item[1].map(read);
      case "o":
        return Object.fromEntries(
          item[1].map(([key, val]) => [strings[key], read(val)])
        );
    }
  };
  return read(value);
}
