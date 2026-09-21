import { describe, expect, it } from "vitest";
import { mapVarProps } from "./mapVarProps.js";

describe("mapVarProps", () => {
  it("returns fresh objects and preserves values without vx normalization", () => {
    const vars = { color: "--color", gap: "--gap" };
    const input = { color: null, gap: false };

    expect(mapVarProps(vars, input)).toEqual({
      "--color": null,
      "--gap": false
    });
    expect(mapVarProps(vars, input)).not.toBe(mapVarProps(vars, input));

    const value = {
      toString() {
        throw new Error("coerced");
      }
    };

    expect(mapVarProps(vars, { color: value })["--color"]).toBe(value);
  });

  it("reads all values, including unknown keys, before consulting mappings", () => {
    const events: string[] = [];
    const input = {
      get gap() {
        events.push("gap");

        return 0;
      },

      get ignored() {
        events.push("ignored");

        return "discarded";
      },

      get color() {
        events.push("color");

        return "red";
      }
    };

    const vars = new Proxy(
      { gap: "--gap", color: "--color" },
      {
        get(target, key, receiver) {
          events.push(`map:${String(key)}`);

          return Reflect.get(target, key, receiver);
        }
      }
    );

    expect(mapVarProps(vars, input)).toEqual({ "--gap": 0, "--color": "red" });
    expect(events).toEqual([
      "gap",
      "ignored",
      "color",
      "map:gap",
      "map:ignored",
      "map:color"
    ]);
  });

  it("matches Object.entries Proxy traps, integer order, symbols, and descriptors", () => {
    const events: string[] = [];
    const source = Object.defineProperty(
      { z: 1, 2: 2, 1: 3, [Symbol("skip")]: 4 },
      "hidden",
      {
        get() {
          throw new Error("hidden value read");
        }
      }
    );

    const input = new Proxy(source, {
      ownKeys(target) {
        events.push("keys");

        return Reflect.ownKeys(target);
      },

      getOwnPropertyDescriptor(target, key) {
        events.push(`descriptor:${String(key)}`);

        return Reflect.getOwnPropertyDescriptor(target, key);
      },

      get(target, key, receiver) {
        events.push(`get:${String(key)}`);

        return Reflect.get(target, key, receiver);
      }
    });

    Object.entries(input);

    const expected = events.splice(0);
    const result = mapVarProps({ 1: "--one", 2: "--two", z: "--z" }, input);

    expect(events).toEqual(expected);
    expect(Object.keys(result)).toEqual(["--one", "--two", "--z"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("preserves exceptions before mapping and ordinary result assignments", () => {
    const vars = { width: "--minchoMappingSetter" };
    const events: unknown[] = [];
    Object.defineProperty(Object.prototype, vars.width, {
      configurable: true,

      set(value) {
        events.push(value);
      }
    });

    try {
      expect(mapVarProps(vars, { width: 4 })).toEqual({});
      expect(events).toEqual([4]);
      expect(() =>
        mapVarProps(vars, {
          width: 8,

          get unknown() {
            throw new Error("unknown");
          }
        })
      ).toThrow("unknown");
      expect(events).toEqual([4]);
    } finally {
      Reflect.deleteProperty(Object.prototype, vars.width);
    }

    const prototype = { marker: true };

    expect(
      Object.getPrototypeOf(
        mapVarProps({ value: "__proto__" }, { value: prototype })
      )
    ).toBe(prototype);
    expect(() => mapVarProps({}, null as never)).toThrow(TypeError);
    expect(() => mapVarProps({}, undefined as never)).toThrow(TypeError);
  });
});
