/**
 * Utility functions for OXC transform
 */

/**
 * Extraction APIs from Mincho and Vanilla Extract
 */
export const extractionAPIs = [
  // @mincho-js/css
  "mincho$",
  "css",
  "globalCss",
  "rules",
  // @vanilla-extract/css
  "style",
  "styleVariants",
  "globalStyle",
  "createTheme",
  "createGlobalTheme",
  "createThemeContract",
  "createGlobalThemeContract",
  "assignVars",
  "createVar",
  "fallbackVar",
  "fontFace",
  "globalFontFace",
  "keyframes",
  "globalKeyframes",
  // @vanilla-extract/recipes
  "recipe"
];

/**
 * Generate a hash code from a string (simple hash function)
 * @param str - String to hash
 * @returns Hash as base36 string
 */
export function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate unique CSS module ID
 * @param filename - Source file path
 * @param position - Position in source file
 * @returns Virtual CSS module ID
 */
export function generateCSSModuleId(filename: string, position: number): string {
  const hash = hashCode(`${filename}:${position}`);
  return `extracted_${hash}.css.ts`;
}

/**
 * Generate unique variable name for CSS import
 * @param baseName - Base name for the variable
 * @param counter - Optional counter for uniqueness
 * @returns Unique variable name
 */
export function generateUniqueVarName(baseName: string, counter?: number): string {
  const suffix = counter !== undefined ? `_${counter}` : "";
  return `$mincho$$${baseName}${suffix}`;
}

/**
 * Check if a comment contains "mincho-ignore"
 * @param comment - Comment text
 * @returns True if comment contains mincho-ignore
 */
export function isIgnoreComment(comment: string): boolean {
  return comment.trim() === "mincho-ignore" || comment.trim() === "mincho-js-ignore";
}

/**
 * Invariant assertion
 * @param cond - Condition to check
 * @param msg - Error message
 */
export function invariant(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(msg);
  }
}




