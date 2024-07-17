import chalk from "chalk";
import boxen from "boxen";
import colorize from "@pinojs/json-colorizer";
import diff from "deep-diff";
import pretifyDeepDiff from "pretify-deep-diff";

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
        padding: 1,
        borderStyle: "round"
      })
    );
  }
};

let count = 0;

function getCount() {
  return (count++).toString().padStart(4, "0");
}

export function debugLog(name?: unknown) {
  const message =
    name === undefined ? `DEBUG-${getCount()}` : `DEBUG-${getCount()}: ${name}`;

  consola.info(chalk.bold(message));
}

export function jsonPrint(arg1: unknown, obj?: unknown) {
  if (obj === undefined) {
    const json = JSON.stringify(arg1, null, 2);
    consola.box(colorize(json));
  } else {
    const json = JSON.stringify(obj, null, 2);
    consola.box(arg1, colorize(json));
  }
}

export function jsonLog(arg1: unknown, obj?: unknown) {
  if (obj === undefined) {
    debugLog();
    jsonPrint(arg1);
  } else {
    debugLog(arg1);
    jsonPrint(obj);
  }
}

export function jsonExpect(arg1: unknown, obj1?: unknown, obj2?: unknown) {
  if (obj2 === undefined) {
    debugLog();
    jsonPrint("Expected", arg1);
    jsonPrint("Real", obj1);

    const changes = diff(arg1, obj1);
    console.log(pretifyDeepDiff(changes ?? []));
  } else {
    debugLog(arg1);
    jsonPrint("Expected", obj1);
    jsonPrint("Real", obj2);

    const changes = diff(obj1, obj2);
    console.log(pretifyDeepDiff(changes ?? []));
  }
}

// == Tests ====================================================================

if (import.meta.vitest) {
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
