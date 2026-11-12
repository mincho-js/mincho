/** Media queries use literal lengths, independently of theme CSS variables. */
export const defaultBreakpoints = {
  sm: "40rem",
  md: "48rem",
  lg: "64rem",
  xl: "80rem",
  "2xl": "96rem"
} as const;

export type Breakpoints = Readonly<Record<string, string | undefined>>;
type ConditionName<Key> = Key extends `${number}${string}`
  ? `screen${Key}`
  : Key;
export type BreakpointConditions<B extends Breakpoints> = {
  [
    K in keyof B as [B[K]] extends [undefined]
      ? never
      : K extends string | number
        ? ConditionName<`${K}`>
        : never
  ]: string extends K
    ? { "@media": string } | undefined
    : number extends K
      ? { "@media": string } | undefined
      : undefined extends B[K]
        ? { "@media": string } | undefined
        : { "@media": string };
};

// Same ordering as Tailwind: group by unit/function, then numeric value or text.
function compareWidths(a: string, b: string): number {
  if (a === b) return 0;

  const bucket = (value: string) =>
    value.includes("(")
      ? value.slice(0, value.indexOf("("))
      : value.replace(/[\d.]+/g, "");
  const left = bucket(a);
  const right = bucket(b);
  const order =
    (left === right ? 0 : left < right ? -1 : 1) ||
    Number.parseFloat(a) - Number.parseFloat(b);

  return Number.isNaN(order) ? (a < b ? -1 : 1) : order;
}

export function breakpointEntries(breakpoints: Breakpoints) {
  const names = new Set<string>();

  return Object.entries(breakpoints)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, width]) => {
      const alias = /^\d/.test(name) ? `screen${name}` : name;

      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(alias) || !width.trim())
        throw new Error(`Invalid Tailwind breakpoint: ${name}`);

      if (names.has(alias))
        throw new Error(`Duplicate Tailwind breakpoint alias: ${alias}`);
      names.add(alias);

      return { name: alias, width: width.trim() };
    })
    .sort((a, b) => compareWidths(a.width, b.width));
}
