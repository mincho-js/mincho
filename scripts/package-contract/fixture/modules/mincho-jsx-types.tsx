/** @jsxImportSource @mincho-js/react */
// This file is checked alongside the Tailwind JSX consumer in the same program.
export const native = <div css={{ color: "rebeccapurple", padding: 12 }} />;
// @ts-expect-error Tailwind's JSX runtime does not augment the base runtime.
export const leaked = <div css={{ bg: "blue-500", px: 3 }} />;
