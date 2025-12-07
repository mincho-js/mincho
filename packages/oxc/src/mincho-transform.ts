import MagicString from "magic-string";
import { parseSync } from "oxc-parser";
import { createHash } from "crypto";
import type { MinchoTransformOptions, MinchoTransformResult } from "./types.js";

/**
 * Mincho Transform Layer - handles Mincho-specific API transformations
 *
 * Transforms:
 * 1. styled("button", {...}) → $$styled("button", rules_import_from_css_file)
 * 2. Extracts CSS to separate .css.ts files (with file scope support)
 *
 * Uses oxc-parser for maximum performance
 */
export function minchoTransform(
  code: string,
  options: MinchoTransformOptions
): MinchoTransformResult {
  const { filename, extractCSS = false } = options;
  const s = new MagicString(code);
  const cssExtractions: Array<{
    id: string;
    content: string;
    dependencies: string[];
  }> = [];
  const dependencies: string[] = [];
  const imports = new Set<string>();
  let hasStyledImport = false;

  try {
    // Parse to validate syntax
    void parseSync(filename, code, {
      sourceType: "module"
    });

    // Check if there's a styled import
    hasStyledImport =
      /import\s+\{[^}]*\bstyled\b[^}]*\}\s+from\s+["']@mincho-js\/react["']/.test(
        code
      );

    if (!hasStyledImport) {
      return {
        code,
        map: null,
        cssExtractions,
        dependencies
      };
    }

    // Remove original styled import
    const styledImportRegex =
      /import\s+\{[^}]*\bstyled\b[^}]*\}\s+from\s+["']@mincho-js\/react["'];?\s*/g;
    let importMatch;
    while ((importMatch = styledImportRegex.exec(code)) !== null) {
      s.remove(importMatch.index, importMatch.index + importMatch[0].length);
    }

    // Find all styled() calls
    const styledMatches = findFunctionCalls(code, "styled");

    for (const { start, end } of styledMatches) {
      const original = code.slice(start, end);
      const argsStart = original.indexOf("(") + 1;
      const firstComma = findFirstCommaOutsideParens(original, argsStart);

      if (firstComma !== -1) {
        const tagPart = original.slice(argsStart, firstComma).trim();
        const restPart = original.slice(firstComma + 1);
        const stylesEnd = findMatchingBrace(restPart, 0);

        if (stylesEnd !== -1) {
          const stylesPart = restPart.slice(0, stylesEnd).trim();
          const remaining = restPart.slice(stylesEnd).trim();
          const closingParen = remaining.indexOf(")");
          const additionalArgs =
            closingParen > 0 ? remaining.slice(0, closingParen).trim() : "";

          // Extract CSS if enabled
          if (extractCSS) {
            // Generate unique hash for this styled call
            const hash = createHash("sha256")
              .update(filename + stylesPart + start)
              .digest("hex")
              .substring(0, 8);

            const cssFileName = `extracted_${hash}.css.ts`;
            const rulesVarName = `__mincho_rules_${hash}`;

            // Create CSS file content with rules() call
            // This file will be processed by compile() which adds file scope
            const cssFileContent = `import { rules } from "@mincho-js/css";

export const ${rulesVarName} = rules(${stylesPart});
`;

            cssExtractions.push({
              id: cssFileName,
              content: cssFileContent,
              dependencies: []
            });

            // Transform to import from extracted CSS file
            const transformed = `/* @__PURE__ */ $$styled(${tagPart}, ${rulesVarName}${
              additionalArgs ? `, ${additionalArgs}` : ""
            })`;

            s.overwrite(start, end, transformed);
            imports.add("$$styled");
            imports.add(rulesVarName); // Track for import generation
          } else {
            // No extraction: inline rules() call (requires file scope in parent)
            const transformed = `/* @__PURE__ */ $$styled(${tagPart}, rules(${stylesPart})${
              additionalArgs ? `, ${additionalArgs}` : ""
            })`;
            s.overwrite(start, end, transformed);
            imports.add("$$styled");
            imports.add("rules");
          }
        }
      }
    }

    // Add necessary imports
    let importsToAdd = "";
    if (imports.size > 0) {
      const importStatements: string[] = [];

      if (imports.has("$$styled")) {
        importStatements.push(
          `import { $$styled } from "@mincho-js/react/runtime";`
        );
      }

      if (extractCSS && cssExtractions.length > 0) {
        // Import extracted rules from CSS files
        for (const { id } of cssExtractions) {
          const hash = id.replace("extracted_", "").replace(".css.ts", "");
          const rulesVarName = `__mincho_rules_${hash}`;
          importStatements.push(`import { ${rulesVarName} } from "./${id}";`);
        }
      } else if (imports.has("rules")) {
        // No extraction: import rules directly
        importStatements.push(`import { rules } from "@mincho-js/css";`);
      }

      importsToAdd += importStatements.join("\n") + "\n";
    }

    if (importsToAdd) {
      s.prepend(importsToAdd);
    }

    return {
      code: s.toString(),
      map: null,
      cssExtractions,
      dependencies
    };
  } catch (error) {
    console.error("[mincho-transform] Parse error:", error);
    return {
      code,
      map: null,
      cssExtractions: [],
      dependencies: []
    };
  }
}

/**
 * Find all function calls of a given name
 */
function findFunctionCalls(
  code: string,
  functionName: string
): Array<{ start: number; end: number }> {
  const results: Array<{ start: number; end: number }> = [];
  const regex = new RegExp(`\\b${functionName}\\s*\\(`, "g");
  let match;

  while ((match = regex.exec(code)) !== null) {
    const start = match.index;
    const openParenIndex = match.index + match[0].length - 1;
    const endIndex = findMatchingClosingParen(code, openParenIndex);

    if (endIndex !== -1) {
      results.push({ start, end: endIndex + 1 });
    }
  }

  return results;
}

/**
 * Find matching closing parenthesis, handling strings and nested parens
 */
function findMatchingClosingParen(code: string, openIndex: number): number {
  let depth = 1;
  let inString = false;
  let stringChar = "";
  let inTemplate = false;
  let templateDepth = 0;

  for (let i = openIndex + 1; i < code.length; i++) {
    const char = code[i];
    const prevChar = i > 0 ? code[i - 1] : "";

    // Skip escaped quotes
    if (prevChar === "\\" && (char === '"' || char === "'" || char === "`")) {
      continue;
    }

    // Handle regular strings
    if ((char === '"' || char === "'") && !inTemplate) {
      if (inString) {
        if (char === stringChar) {
          inString = false;
        }
      } else {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    // Handle template literals
    if (char === "`" && !inString) {
      if (inTemplate) {
        templateDepth--;
        if (templateDepth === 0) {
          inTemplate = false;
        }
      } else {
        inTemplate = true;
        templateDepth = 1;
      }
      continue;
    }

    if (inString || inTemplate) continue;

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Find first comma outside of parentheses and strings
 */
function findFirstCommaOutsideParens(code: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = startIndex; i < code.length; i++) {
    const char = code[i];
    const prevChar = i > 0 ? code[i - 1] : "";

    if (prevChar === "\\" && (char === '"' || char === "'")) {
      continue;
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true;
      stringChar = char;
      continue;
    }

    if (inString && char === stringChar) {
      inString = false;
      continue;
    }

    if (inString) continue;

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (char === "," && depth === 0) {
      return i;
    }
  }

  return -1;
}

/**
 * Find matching closing brace for object literal
 */
function findMatchingBrace(code: string, startIndex: number): number {
  let i = startIndex;

  // Skip whitespace
  while (i < code.length && /\s/.test(code[i])) {
    i++;
  }

  if (code[i] !== "{") {
    return -1;
  }

  let depth = 1;
  let inString = false;
  let stringChar = "";
  let inTemplate = false;

  for (let j = i + 1; j < code.length; j++) {
    const char = code[j];
    const prevChar = j > 0 ? code[j - 1] : "";

    if (prevChar === "\\" && (char === '"' || char === "'" || char === "`")) {
      continue;
    }

    if ((char === '"' || char === "'") && !inTemplate) {
      if (inString) {
        if (char === stringChar) {
          inString = false;
        }
      } else {
        inString = true;
        stringChar = char;
      }
      continue;
    }

    if (char === "`" && !inString) {
      inTemplate = !inTemplate;
      continue;
    }

    if (inString || inTemplate) continue;

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return j + 1;
      }
    }
  }

  return -1;
}
