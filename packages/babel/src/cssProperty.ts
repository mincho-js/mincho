export function isNestedCssObjectKey(propertyName: string): boolean {
  return (
    propertyName === "selectors" ||
    propertyName === "vars" ||
    propertyName.startsWith("@") ||
    propertyName.startsWith("_") ||
    propertyName.startsWith("$") ||
    propertyName.includes("&") ||
    propertyName.includes(":") ||
    propertyName.includes(" ")
  );
}

export function isSupportedCssDeclarationProperty(
  propertyName: string
): boolean {
  return !propertyName.startsWith("--") && !isNestedCssObjectKey(propertyName);
}
