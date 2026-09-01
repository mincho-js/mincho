import { createRequire } from "node:module";

// Resolve the built-in preset from Integration, independently of the consumer cwd.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: declaration builds also check this source with a CommonJS target.
export const typescriptPresetPath = createRequire(import.meta.url).resolve(
  "@babel/preset-typescript"
);
