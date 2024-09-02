export function mapValues<Input extends Record<string, unknown>, OutputValue>(
  input: Input,
  fn: (value: Input[keyof Input], key: keyof Input) => OutputValue
): Record<keyof Input, OutputValue> {
  const result = {} as Record<keyof Input, OutputValue>;

  for (const key in input) {
    result[key] = fn(input[key], key);
  }

  return result;
}
