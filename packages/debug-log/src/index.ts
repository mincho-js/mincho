// import chalk from "chalk";
// import boxen from "boxen";
import colorize from "@pinojs/json-colorizer";
import diff from "deep-diff";
import pretifyDeepDiff from "@mincho-js/pretify-deep-diff";
import type Chalk from "chalk";
import type Boxen from "boxen";

/** Dynamic import for commonjs
Will will use IIFE for import.

```text
Uncaught:
Error [ERR_REQUIRE_ESM]: require() of ES Module /home/black7375/mincho/node_modules/.store/boxen-npm-8.0.0-0f4620e170/package/index.js not supported.
Instead change the require of index.js in null to a dynamic import() which is available in all CommonJS modules.
    at Module._extensions..js (node:internal/modules/cjs/loader:1519:19)
    at Module.load (node:internal/modules/cjs/loader:1282:32)
    at Module._load (node:internal/modules/cjs/loader:1098:12)
    at TracingChannel.traceSync (node:diagnostics_channel:315:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:215:24)
    at Module.require (node:internal/modules/cjs/loader:1304:12)
    at require (node:internal/modules/helpers:123:16) {
  code: 'ERR_REQUIRE_ESM'
}
```
 */

// let chalk: typeof Chalk;
// (async () => {
//   chalk = (await import("chalk")).default;
// })();
let chalkPromise: Promise<typeof Chalk>;
(async () => {
  chalkPromise = import("chalk").then((module) => module.default);
})();

let boxenPromise: Promise<typeof Boxen>;
(async () => {
  boxenPromise = import("boxen").then((module) => module.default);
})();

// == Console ==================================================================
// consola fancy is not works in test
// Use an alternate implementation for a while until the issue is resolved.
// https://github.com/unjs/consola/issues/310
const consola = {
  log(...args: unknown[]) {
    console.log(...args);
  },
  async info(...args: unknown[]) {
    const chalk = await chalkPromise;
    console.log(chalk.cyan("\nℹ"), ...args);
  },
  async box(arg1: unknown, ...args: unknown[]) {
    const boxen = await boxenPromise;
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

export async function debugLog(name?: string) {
  const chalk = await chalkPromise;
  const message =
    name === undefined ? `DEBUG-${getCount()}` : `DEBUG-${getCount()}: ${name}`;

  consola.info(chalk.bold(message));
}

export async function jsonPrint<T>(obj: JSONCompatible<T>): Promise<void>;
export async function jsonPrint<T>(
  name: string,
  obj?: JSONCompatible<T>
): Promise<void>;
export async function jsonPrint<T>(
  nameOrObj: string | JSONCompatible<T>,
  obj?: JSONCompatible<T>
) {
  if (obj === undefined) {
    const json = JSON.stringify(nameOrObj, null, 2);
    await consola.box(colorize(json));
  } else {
    const json = JSON.stringify(obj, null, 2);
    await consola.box(nameOrObj, colorize(json));
  }
}

export async function jsonLog<T>(obj: JSONCompatible<T>): Promise<void>;
export async function jsonLog<T>(
  name: string,
  obj?: JSONCompatible<T>
): Promise<void>;
export async function jsonLog<T>(
  nameOrObj: string | JSONCompatible<T>,
  obj?: JSONCompatible<T>
) {
  if (obj === undefined) {
    await debugLog();
    // We will forced assert, becasue don't want to overhead
    await jsonPrint(nameOrObj as JSONCompatible<T>);
  } else {
    await debugLog(nameOrObj as string);
    await jsonPrint(obj);
  }
}

export async function jsonExpect<T, K = T>(
  obj1: JSONCompatible<T>,
  obj2?: JSONCompatible<K>
): Promise<void>;
export async function jsonExpect<T, K = T>(
  name: string,
  obj1?: JSONCompatible<T>,
  obj2?: JSONCompatible<K>
): Promise<void>;
export async function jsonExpect<T, K = T>(
  nameOrObj: string | JSONCompatible<T>,
  obj1?: JSONCompatible<T> | JSONCompatible<K>,
  obj2?: JSONCompatible<K>
) {
  if (obj2 === undefined) {
    await debugLog();
    const changes = diff(nameOrObj, obj1);

    if (changes === undefined) {
      // We will forced assert, becasue don't want to overhead
      await jsonPrint("Same Contents", nameOrObj as JSONCompatible<T>);
    } else {
      await jsonPrint("Expected", nameOrObj as JSONCompatible<T>);
      await jsonPrint("Real", obj1 as JSONCompatible<K>);

      console.log(pretifyDeepDiff(changes ?? []));
    }
  } else {
    await debugLog(nameOrObj as string);
    const changes = diff(obj1, obj2);

    if (changes === undefined) {
      await jsonPrint("Same Contents", obj1 as JSONCompatible<T>);
    } else {
      await jsonPrint("Expected", obj1 as JSONCompatible<T>);
      await jsonPrint("Real", obj2 as JSONCompatible<K>);

      console.log(pretifyDeepDiff(changes ?? []));
    }
  }
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { it, expect } = import.meta.vitest;

  const TEST_PASS = () => {
    expect(1).toBeLessThan(100);
  };

  it("debugLog", async () => {
    await debugLog();
    console.log("test");

    await debugLog("with title debugLog");
    console.log("test2");

    /** OUTPUT
      ℹ DEBUG-0000
      test

      ℹ DEBUG-0001: with title debugLog
      test2
     */
    TEST_PASS();
  });

  it("jsonLog", async () => {
    await jsonLog({ key1: true, key2: 1, key3: null, key4: "string" });
    await jsonLog("with title jsonLog", { others: undefined });

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

  it("jsonExpect", async () => {
    await jsonExpect({ a: 1 }, { a: 2 });
    await jsonExpect("with title jsonExpect", { b: 1 }, { c: "1" });

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
