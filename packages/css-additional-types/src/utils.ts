const kebabCaseRegex = /-./g;
export function kebabToCamel(kebabCase: string) {
  const camel = kebabCase.replace(kebabCaseRegex, (match) =>
    match[1].toUpperCase()
  );

  // Vender Prefix for IE
  // https://github.com/frenic/csstype/issues/192
  if (camel.startsWith("Ms")) {
    return firstCharToLower(camel);
  }
  return camel;
}

export function isArray<T>(value: T | T[]): value is T[] {
  return Array.isArray(value);
}

export function stringify(object: object) {
  return JSON.stringify(object, null, 2);
}

export function removeFirstString(str: string, remove: string) {
  return str.replace(remove, "");
}

export function firstCharToLower(str: string) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
