const upperCaseRegex = /[A-Z]/g;
export function camelToKebab(camelCase: string) {
  return camelCase.replace(upperCaseRegex, "-$&").toLowerCase();
}

export function convertToCSSVar(cssVar: string) {
  const without$ = cssVar.substring(1);
  const kebabCase = camelToKebab(without$);
  return `--${kebabCase}`;
}

export function isUppercase(str: string) {
  const firstLetter = str.charCodeAt(0);
  return firstLetter >= 65 && firstLetter <= 90;
}
