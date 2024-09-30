import { accessSync, mkdirSync, createWriteStream } from "fs";
import { join } from "path";
import { cwd } from "process";
import properties from "mdn-data/css/properties.json";
import syntaxes from "mdn-data/css/syntaxes.json";
import { camelPseudo } from "./simple-pseudo";
import { kebabToCamel, isArray, stringify, removeFirstString } from "./utils";

// == Common ===================================================================
const cssProperties = Object.entries(properties);
const syntaxProperties = Object.entries(syntaxes);

interface CssEntries {
  [key: string]: string[];
}
interface CssNested {
  [key: string]: Record<string, string>;
}

// == Merge Values =============================================================
// -- Utils --------------------------------------------------------------------
function isComma(syntax: string) {
  // https://developer.mozilla.org/en-US/docs/Web/CSS/Value_definition_syntax
  return syntax.includes(", ") || syntax.includes("#");
}

const spaceRegex = /<?[\w-]+>? <?[\w-]+>?/;
function isSpace(syntax: string) {
  return (
    syntax.includes("&&") ||
    syntax.includes("||") ||
    syntax.includes("*") ||
    syntax.includes("+") ||
    syntax.includes("?") ||
    spaceRegex.test(syntax)
  );
}

function isNotFn(keyedSyntax: string) {
  return !keyedSyntax.endsWith("()");
}

function isNotSpaceKey(key: string) {
  return key !== "--*";
}

// -- Syntax filter ------------------------------------------------------------
const [level1CommaSyntaxes, level1SpaceSyntaxes]: [string[], string[]] =
  syntaxProperties.reduce(
    (acc: [string[], string[]], [key, value]) => {
      if (isNotFn(key)) {
        const syntax = value.syntax;
        if (isComma(syntax)) {
          acc[0].push(key);
        } else if (isSpace(syntax)) {
          acc[1].push(key);
        }
      }
      return acc;
    },
    [[], []] as [string[], string[]]
  );
function syntaxFilter(syntaxes: string[], syntaxSet = new Set<string>()) {
  const newSyntaxes = new Set([...syntaxSet, ...syntaxes]);
  const result = syntaxes.reduce((acc: string[], syntax) => {
    for (const [key, value] of syntaxProperties) {
      if (
        isNotFn(key) &&
        value.syntax.includes(`<${syntax}>`) &&
        !newSyntaxes.has(key)
      ) {
        acc.push(key);
      }
    }
    return acc;
  }, [] as string[]);

  if (result.length > 0) {
    return syntaxFilter(result, newSyntaxes);
  } else {
    return [...newSyntaxes, ...result];
  }
}

const commaSyntaxes = syntaxFilter(level1CommaSyntaxes);
const spaceSyntaxes = syntaxFilter(level1SpaceSyntaxes);

function syntaxIncludes(targetSyntax: string, syntaxes: string[]) {
  return syntaxes.some((syntax) => targetSyntax.includes(syntax));
}

// -- Interface ----------------------------------------------------------------
const [comma, whiteSpace]: [CssEntries, CssEntries] = cssProperties.reduce(
  (acc: [CssEntries, CssEntries], [key, value]) => {
    const syntax = value.syntax;
    if (isComma(syntax) || syntaxIncludes(syntax, commaSyntaxes)) {
      acc[0][kebabToCamel(key)] = [syntax]; // For debugging
    } else if (
      isNotSpaceKey(key) &&
      (isSpace(syntax) || syntaxIncludes(syntax, spaceSyntaxes))
    ) {
      acc[1][kebabToCamel(key)] = [syntax];
    }

    return acc;
  },
  [{}, {}] as [CssEntries, CssEntries]
);

function makeMergeTypes(entries: CssEntries) {
  return arrayKeyTypes(Object.keys(entries));
}

function arrayKeyTypes(arr: string[]) {
  return arr.map((key) => `"${key}"`).join("\n  | ");
}

// == Shorthanded & Nested =====================================================
const shorthanded: CssEntries = cssProperties.reduce(
  (acc: CssEntries, [key, value]) => {
    const initial = value.initial;
    if (isArray(initial)) {
      acc[kebabToCamel(key)] = initial.map(kebabToCamel);
    }
    return acc;
  },
  {} as CssEntries
);

function makeNestedKey(originKey: string, shorthandKey: string) {
  return kebabToCamel(removeFirstString(originKey, shorthandKey));
}
const nested: CssNested = cssProperties.reduce((acc: CssNested, [key]) => {
  const nestedEntries = cssProperties.filter(([originKey]) =>
    originKey.startsWith(`${key}-`)
  );
  if (nestedEntries.length > 0) {
    acc[kebabToCamel(key)] = nestedEntries.reduce(
      (acc: Record<string, string>, [originKey]) => {
        acc[makeNestedKey(originKey, key)] = kebabToCamel(originKey);
        return acc;
      },
      {} as Record<string, string>
    );
  }
  return acc;
}, {} as CssNested);

// == Main =====================================================================
// -- Setup --------------------------------------------------------------------
const saveDir = join(cwd(), "dist");
const savePath = join(saveDir, "index.ts");

const stringifyNested = stringify(nested);
const result = `// https://stackoverflow.com/questions/42999983/typescript-removing-readonly-modifier
type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> };

export type CamelPseudos = ${arrayKeyTypes(camelPseudo)};

export type SpacePropertiesKey = ${makeMergeTypes(whiteSpace)};
export type CommaPropertiesKey = ${makeMergeTypes(comma)};

export const shorthandProperties = ${stringify(shorthanded)} as const;
export type ShorthandProperties = DeepWriteable<typeof shorthandProperties>;

export const nestedPropertiesMap: NestedPropertiesMap = ${stringifyNested};
export type NestedPropertiesMap = ${stringifyNested};
`;

// -- Run ----------------------------------------------------------------------
interface FileError {
  code: string;
}
function main() {
  try {
    accessSync(saveDir);
  } catch (error) {
    const err = error as FileError;
    if (err.code === "ENOENT") {
      try {
        mkdirSync(saveDir);
      } catch (error) {
        const err = error as FileError;
        if (err.code !== "EEXIST") {
          throw err;
        }
      }
    }
  }

  const stream = createWriteStream(savePath);
  stream.write(result);
  stream.end();
}

main();
