import chalk from "chalk";
import boxen from "boxen";
import colorize from "@pinojs/json-colorizer";
import diff from "deep-diff";
import prettifyDeepDiff from "@mincho-js/pretify-deep-diff";

// == Console ==================================================================
// consola fancy is not works in test
// Use an alternate implementation for a while until the issue is resolved.
// https://github.com/unjs/consola/issues/310
const consola = {
  log(...args: unknown[]) {
    console.log(...args);
  },
  info(...args: unknown[]) {
    console.log(chalk.cyan("\nℹ"), ...args);
  },
  box(arg1: unknown, ...args: unknown[]) {
    const isExistArgs = args.length !== 0;
    console.log(
      boxen(isExistArgs ? args.join(" ") : (arg1 as string), {
        title: isExistArgs ? (arg1 as string) : undefined,
        padding: {
          top: 1,
          bottom: 1,
          left: 2,
          right: 2
        },
        borderStyle: "round"
      })
    );
  }
};

// == Json Comportable Type ====================================================
type NotAssignableToJson = bigint | symbol | ((...args: unknown[]) => unknown);

type JSONPrimitive = string | number | boolean | null | undefined;
type JSONValue =
  | JSONPrimitive
  | JSONValue[]
  | {
      [key: string]: JSONValue;
    };

type JSONCompatible<T> = unknown extends T
  ? never
  : {
      [P in keyof T]: T[P] extends JSONValue
        ? T[P]
        : T[P] extends NotAssignableToJson
          ? never
          : JSONCompatible<T[P]>;
    };

// == DebugLog =================================================================
let count = 0;

function getCount() {
  return (count++).toString().padStart(4, "0");
}

export function debugLog(name?: string) {
  const message =
    name === undefined ? `DEBUG-${getCount()}` : `DEBUG-${getCount()}: ${name}`;

  consola.info(chalk.bold(message));
}

export function jsonPrint<T>(obj: JSONCompatible<T>): void;
export function jsonPrint<T>(name: string, obj?: JSONCompatible<T>): void;
export function jsonPrint<T>(
  nameOrObj: string | JSONCompatible<T>,
  obj?: JSONCompatible<T>
) {
  if (obj === undefined) {
    const json = JSON.stringify(nameOrObj, null, 2);
    consola.box(colorize(json));
  } else {
    const json = JSON.stringify(obj, null, 2);
    consola.box(nameOrObj, colorize(json));
  }
}

export function jsonLog<T>(obj: JSONCompatible<T>): void;
export function jsonLog<T>(name: string, obj?: JSONCompatible<T>): void;
export function jsonLog<T>(
  nameOrObj: string | JSONCompatible<T>,
  obj?: JSONCompatible<T>
) {
  if (obj === undefined) {
    debugLog();
    // We will forced assert, because don't want to overhead
    jsonPrint(nameOrObj as JSONCompatible<T>);
  } else {
    debugLog(nameOrObj as string);
    jsonPrint(obj);
  }
}

export function jsonExpect<T, K = T>(
  obj1: JSONCompatible<T>,
  obj2?: JSONCompatible<K>
): void;
export function jsonExpect<T, K = T>(
  name: string,
  obj1?: JSONCompatible<T>,
  obj2?: JSONCompatible<K>
): void;
export function jsonExpect<T, K = T>(
  nameOrObj: string | JSONCompatible<T>,
  obj1?: JSONCompatible<T> | JSONCompatible<K>,
  obj2?: JSONCompatible<K>
) {
  if (obj2 === undefined) {
    debugLog();
    const changes = diff(nameOrObj, obj1);

    if (changes === undefined) {
      // We will forced assert, because don't want to overhead
      jsonPrint("Same Contents", nameOrObj as JSONCompatible<T>);
    } else {
      jsonPrint("Expected", nameOrObj as JSONCompatible<T>);
      jsonPrint("Real", obj1 as JSONCompatible<K>);

      console.log(prettifyDeepDiff(changes ?? []));
    }
  } else {
    debugLog(nameOrObj as string);
    const changes = diff(obj1, obj2);

    if (changes === undefined) {
      jsonPrint("Same Contents", obj1 as JSONCompatible<T>);
    } else {
      jsonPrint("Expected", obj1 as JSONCompatible<T>);
      jsonPrint("Real", obj2 as JSONCompatible<K>);

      console.log(prettifyDeepDiff(changes ?? []));
    }
  }
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { it, expect } = import.meta.vitest;

  const TEST_PASS = () => {
    expect(1).toBeLessThan(100);
  };

  it("debugLog", () => {
    debugLog();
    console.log("test");

    debugLog("with title debugLog");
    console.log("test2");

    /** OUTPUT
      ℹ DEBUG-0000
      test

      ℹ DEBUG-0001: with title debugLog
      test2
     */
    TEST_PASS();
  });

  it("jsonLog", () => {
    jsonLog({ key1: true, key2: 1, key3: null, key4: "string" });
    jsonLog("with title jsonLog", { others: undefined });

    /* OUTPUT
      ℹ DEBUG-0002
      ╭────────────────────────╮
      │                        │
      │   {                    │
      │     "key1": true,      │
      │     "key2": 1,         │
      │     "key3": null,      │
      │     "key4": "string"   │
      │   }                    │
      │                        │
      ╰────────────────────────╯

      ℹ DEBUG-0003: with title jsonLog
      ╭────────╮
      │        │
      │   {}   │
      │        │
      ╰────────╯
    */
    TEST_PASS();
  });

  it("jsonExpect", () => {
    jsonExpect({ a: 1 }, { a: 2 });
    jsonExpect("with title jsonExpect", { b: 1 }, { c: "1" });

    /* OUTPUT
      ℹ DEBUG-0004
      ╭ Expected ────╮
      │              │
      │   {          │
      │     "a": 1   │
      │   }          │
      │              │
      ╰──────────────╯
      ╭ Real ────────╮
      │              │
      │   {          │
      │     "a": 2   │
      │   }          │
      │              │
      ╰──────────────╯
      ✏️ Edited:
      ✏️ Edited: a from 1 → 2

      ℹ DEBUG-0005: with title jsonExpect
      ╭ Expected ────╮
      │              │
      │   {          │
      │     "b": 1   │
      │   }          │
      │              │
      ╰──────────────╯
      ╭ Real ──────────╮
      │                │
      │   {            │
      │     "c": "1"   │
      │   }            │
      │                │
      ╰────────────────╯
      ➕ Added:
      ➕ Added: c = "1"
      ❌ Deleted:
      ❌ Deleted: b
    */
    TEST_PASS();
  });
}
