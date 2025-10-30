/**
 * Shared utility functions for Mincho Vite plugins
 */

/**
 * Match both the old format and the new virtual format for extracted CSS files
 */
export function extractedCssFileFilter(filePath: string): boolean {
  const extractedIndex = filePath.indexOf("extracted_");
  if (extractedIndex === -1) {
    return false;
  }

  const afterExtracted = filePath.substring(extractedIndex);
  if (afterExtracted.includes("/")) {
    return false;
  }

  if (
    !(
      afterExtracted.endsWith(".css.ts") ||
      afterExtracted.endsWith(".css.ts?used")
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Normalize path by removing leading slash
 */
export function customNormalize(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}
