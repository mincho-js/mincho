const upperCaseRegex = /[A-Z]/g;
export function camelToKebab(camelCase: string) {
  return camelCase.replace(upperCaseRegex, "-$&").toLowerCase();
}
