const upperCaseRegex = /[A-Z]/g;
export function camelToKebab(camelCase: string) {
  return camelCase.replace(upperCaseRegex, "-$&").toLowerCase();
}

export function convertToCSSVar(cssVar: string) {
  const without$ = cssVar.substring(1);
  const kebabCase = camelToKebab(without$);
  return `--${kebabCase}`;
}
