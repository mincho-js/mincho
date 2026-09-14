import { resolveFromModule } from "../moduleResolution.js";

// Resolve fixtures' presets from this package, independently of the test cwd.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: declaration builds also check this source with a CommonJS target.
const moduleUrl = import.meta.url;
export const typescriptPresetPath = resolveFromModule(
  moduleUrl,
  "@babel/preset-typescript"
);
