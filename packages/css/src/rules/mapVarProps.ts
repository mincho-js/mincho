/** Map values without coercion. Snapshot every enumerable string value first. */
export function mapVarProps(
  propVars: Readonly<Record<string, string | undefined>>,
  input: object
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(input)) {
    const variable = propVars[name];

    if (variable !== undefined) result[variable] = value;
  }

  return result;
}
