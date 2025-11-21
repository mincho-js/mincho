// == cx() Types ===============================================================
// https://github.com/lukeed/clsx/blob/master/clsx.d.mts
/**
 * Valid class value types for cx()
 * Supports strings, numbers, objects, arrays, and falsy values
 */
export type ClassValue =
  | ClassArray
  | ClassDictionary
  | string
  | number
  | bigint
  | null
  | boolean
  | undefined;

/**
 * Object with class names as keys and boolean conditions as values
 * @example { 'bg-blue-500': true, 'text-white': isActive }
 */
export type ClassDictionary = Record<string, unknown>;

/**
 * Array of class values (supports nesting)
 */
export type ClassArray = ClassValue[];
