import { tags } from "./tags.js";

/** Callable exports used when registering a preset's styled factory. */
export const styledCalls = [
  "styled",
  ...tags.map((tag) => `styled.${tag}` as const)
] as const;
