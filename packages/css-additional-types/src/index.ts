import { accessSync, mkdirSync, createWriteStream } from "fs";
import { join } from "path";
import { cwd } from "process";
import properties from "mdn-data/css/properties.json";
import {
  kebabToCamel,
  isArray,
  stringify,
  removeFirstString,
  firstCharToLower
} from "./utils";

const cssProperties = Object.entries(properties);
interface ShorthandEntries {
  [key: string]: string[];
}
const shorthanded: ShorthandEntries = cssProperties.reduce(
  (acc: ShorthandEntries, [key, value]) => {
    const initial = value.initial;
    if (isArray(initial)) {
      acc[kebabToCamel(key)] = initial.map(kebabToCamel);
    }
    return acc;
  },
  {} as ShorthandEntries
);

function makeNestedKey(originKey: string, shorthandKey: string) {
  return firstCharToLower(
    kebabToCamel(removeFirstString(originKey, shorthandKey))
  );
}
const nested: ShorthandEntries = cssProperties.reduce(
  (acc: ShorthandEntries, [key]) => {
    const nestedEntries = cssProperties.filter(([originKey]) =>
      originKey.startsWith(`${key}-`)
    );
    if (nestedEntries.length > 0) {
      acc[kebabToCamel(key)] = nestedEntries.map(([originKey]) =>
        makeNestedKey(originKey, key)
      );
    }
    return acc;
  },
  {} as ShorthandEntries
);

const result = `// https://stackoverflow.com/questions/42999983/typescript-removing-readonly-modifier
type DeepWriteable<T> = { -readonly [P in keyof T]: DeepWriteable<T[P]> };
export const shorthandProperties = ${stringify(shorthanded)} as const;
export type ShorthandProperties = DeepWriteable<typeof shorthandProperties>;

export const nestedProperties = ${stringify(nested)} as const;
export type NestedProperties = DeepWriteable<typeof nestedProperties>;
`;

const saveDir = join(cwd(), "dist");
const savePath = join(saveDir, "index.ts");

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
