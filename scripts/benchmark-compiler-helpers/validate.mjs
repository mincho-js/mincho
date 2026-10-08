import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = resolve(process.argv[2]);
const symbol = Symbol("spread property");
const keys = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderTopWidth",
  "borderBottomWidth"
];

function input(events, failure) {
  const observe = (label, object) =>
    new Proxy(object, {
      ownKeys(target) {
        events.push(`${label}.keys`);

        return Reflect.ownKeys(target);
      },

      getOwnPropertyDescriptor(target, key) {
        events.push(`${label}.descriptor:${String(key)}`);

        return Reflect.getOwnPropertyDescriptor(target, key);
      },

      get(target, key, receiver) {
        events.push(`${label}.get:${String(key)}`);

        if (`${label}.${String(key)}` === failure)
          throw new Error("expected getter error");

        return Reflect.get(target, key, receiver);
      }
    });

  const spread = (name) =>
    observe(name, {
      id: name,
      key: name,
      ref: name,
      className: name,
      style: observe(`${name}.style`, { opacity: 0.5, display: "block" }),
      [symbol]: name,
      ["__proto__"]: name
    });

  const data = { tone: "blue", size: "lg", color: null, unknown: 7 };

  for (const [index, key] of keys.entries()) data[key] = index;

  data.pre = spread("pre");
  data.post = spread("post");

  return observe("input", data);
}

async function load(version, scenario, format) {
  const mod = await import(
    pathToFileURL(join(directory, version, `${scenario}.${format}`))
  );

  return mod.run ?? mod.default.run;
}

function evaluate(run, site, failure) {
  const events = [];
  const value = input(events, failure);

  try {
    const result = run(value, site);

    return { events, result, keys: Reflect.ownKeys(Object(result)) };
  } catch (error) {
    return { events, error: [error.constructor.name, error.message] };
  }
}

let comparisons = 0;

for (const format of ["mjs", "cjs"]) {
  for (const scenario of [
    "props-static",
    "props-dynamic",
    "classes",
    "both",
    "vars4",
    "vars8",
    "vars16"
  ]) {
    const before = await load("before", scenario, format);
    const after = await load("after", scenario, format);

    for (const failure of [
      undefined,
      "input.width",
      "input.color",
      "input.unknown"
    ]) {
      assert.deepEqual(
        evaluate(after, 0, failure),
        evaluate(before, 0, failure),
        `${scenario}/${format}/${failure}`
      );

      comparisons++;
    }
  }

  for (const [scenario, candidates, sites] of [
    ["spreads1", ["finish", "finish-owned"], 1],
    ["spreads10", ["finish", "finish-owned"], 10],
    ["spreads50", ["finish", "finish-owned"], 50],
    ["vars4", ["writer"], 10],
    ["vars8", ["writer"], 10],
    ["vars16", ["writer"], 10]
  ]) {
    const inline = await load("after", scenario, format);

    for (const candidate of candidates) {
      const run = await load("after", `${scenario}-${candidate}`, format);

      for (let site = 0; site < sites; site++)
        for (const failure of [
          undefined,
          "input.width",
          "pre.className",
          "post.style",
          "pre.style.opacity"
        ]) {
          assert.deepEqual(
            evaluate(run, site, failure),
            evaluate(inline, site, failure),
            `${scenario}-${candidate}/${format}/${site}/${failure}`
          );

          comparisons++;
        }
    }
  }
}

console.log(
  `Compiler helper differential validation: ${comparisons} comparisons passed`
);
