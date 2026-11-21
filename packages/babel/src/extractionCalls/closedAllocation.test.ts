import { describe, expect, it } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import {
  isClosedFreshAllocationFactory,
  describeClosedOwnAllocationFactory
} from "./closedAllocation.js";
function proves(source: string) {
  const program = parseModuleProgram("/fixture/provider.ts", source);
  const binding = program.scope.getBinding("factory");
  if (!binding) throw new Error("missing factory");
  return isClosedFreshAllocationFactory(
    binding.path.isVariableDeclarator()
      ? binding.path.get("init")
      : binding.path
  );
}
describe("closed returned allocation ownership", () => {
  it.each([
    `function factory(config) { return {css: style => style.color, cx: (...classes) => classes.join(" ")}; }`,
    `const factory = () => ({nested: [{color: "red"}], callback: value => {const local = value; return local;}});`,
    `const factory = () => value => value;`,
    `const palette = {red: "red"}; const factory = () => ({make: (color: keyof typeof palette): keyof typeof palette => color});`
  ])("proves only the freshly allocated initial graph: %s", (source) =>
    expect(proves(source)).toBe(true)
  );
  it.each([
    `const palette = {red: "red"}; const factory = () => ({read: () => {declare const palette: {red: string}; return palette.red;}});`,
    `const shared={}; function factory() {return shared;}`,
    `const shared={}; function factory() {return {value: shared};}`,
    `const shared={}; function factory() {return {read: () => shared};}`,
    `const palette = {red: "red"}; const factory = () => ({make: (color: keyof typeof palette) => palette[color]});`,
    `function factory(config) {return {read: () => config};}`,
    `function factory() {return {get value(){return {};}};}`,
    `function factory() {return {...{color:"red"}};}`,
    `function factory() {return {["color"]:"red"};}`,
    `function factory() {return {__proto__:null};}`,
    `function factory() {return new Object();}`,
    `function factory() {return {read: () => globalThis.shared};}`,
    `function factory() {return {read: () => this};}`,
    `function factory() {return {read: function(){return arguments;}};}`,
    `function factory() {return {read: function(){return new.target;}};}`,
    `function factory() {return {read: () => eval("globalThis")};}`,
    `function factory() {return {read: () => import("./state")};}`,
    `function factory(x = observe()) {return {};}`,
    `function factory() {observe();return {};}`,
    `async function factory() {return {};}`,
    `function* factory() {return {};}`,
    `function factory() {return {read: async () => 1};}`
  ])(
    "withholds ownership for unsupported allocation or captures: %s",
    (source) => expect(proves(source)).toBe(false)
  );
});

it("describes only known own fields, without granting prototypes or invocation effects", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    `
    function factory() {return {nested:[{value: 1}], callback: input => input()};}
  `
  );
  const binding = program.scope.getBinding("factory")!;
  expect(describeClosedOwnAllocationFactory(binding.path)).toEqual({
    kind: "object",
    properties: {
      nested: {
        kind: "array",
        elements: [
          { kind: "object", properties: { value: { kind: "primitive" } } }
        ]
      },
      callback: { kind: "function" }
    }
  });
});

it("keeps every own-shape property dictionary free of inherited entries", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    'function factory() { return {nested: {}, constructor: 1, toString: "own"}; }'
  );
  const shape = describeClosedOwnAllocationFactory(
    program.scope.getBinding("factory")!.path
  );
  expect(shape?.kind).toBe("object");
  if (shape?.kind !== "object") throw new Error("Expected object shape");
  expect(Object.getPrototypeOf(shape.properties)).toBeNull();
  expect(shape.properties.constructor).toEqual({ kind: "primitive" });
  expect(shape.properties.toString).toEqual({ kind: "primitive" });
  expect(shape.properties.hasOwnProperty).toBeUndefined();
  const nested = shape.properties.nested;
  if (nested?.kind !== "object")
    throw new Error("Expected nested object shape");
  expect(Object.getPrototypeOf(nested.properties)).toBeNull();
  for (const name of ["constructor", "toString", "__proto__"])
    expect(nested.properties[name]).toBeUndefined();
});

it.each([
  "shared = 1",
  "shared += 1",
  "shared++",
  "++shared",
  "[shared] = [1]",
  "({value: shared} = {value: 1})",
  "[...shared] = [1]",
  "({value: shared = 1} = {})",
  "for (shared of [1]) {}",
  "for (shared in {x: 1}) {}",
  "(() => { shared = 1 })()"
])("rejects write-only external capture: %s", (body) => {
  expect(
    proves(`let shared=0;function factory(){return {set:()=>{${body};}}}`)
  ).toBe(false);
});
it.each([
  "local = 1",
  "local += 1",
  "local++",
  "[local]=[1]",
  "({value:local}={value:1})",
  "for(local of [1]){}",
  "for(local in {x:1}){}"
])("keeps local writes ownership-only: %s", (body) => {
  expect(
    proves(`function factory(){return {set:()=>{let local=0;${body};}}}`)
  ).toBe(true);
});

// Unlowered JSX also depends on the selected JSX runtime, not just tag bindings.
it.each([
  `const External = () => null; function factory() {return {render: () => <External />};}`,
  `const External = {View: () => null}; function factory() {return {render: () => <External.View />};}`,
  `function factory() {return {render: () => <section />};}`,
  `function factory() {return {render: () => <>text</>};}`,
  `function factory() {return {render: () => {const Local = () => null; return <Local />;}};}`
])("withholds closed ownership for unlowered JSX: %s", (source) => {
  const program = parseModuleProgram("/fixture/provider.tsx", source);
  expect(
    isClosedFreshAllocationFactory(program.scope.getBinding("factory")!.path)
  ).toBe(false);
});

it("withholds ownership for a callback's lexical private-name dependency", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "class Outer { #brand; static factory = () => ({ test: value => #brand in value }); }"
  );
  let result: boolean | undefined;
  program.traverse({
    ClassProperty(path) {
      if (path.node.static)
        result = isClosedFreshAllocationFactory(path.get("value"));
    }
  });
  expect(result).toBe(false);
});

it("keeps private names declared inside the returned callback local", () => {
  expect(
    proves(
      `function factory(){return {test: value=> {class Local {#brand; static has(candidate){return #brand in candidate;}} return Local.has(value);}};}`
    )
  ).toBe(true);
});
it("does not let a nested class hide an outer private capture", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    `class Outer {#brand; static factory=()=>({test:value=>{class Local {static has(candidate){return #brand in candidate;}} return Local.has(value);}});}`
  );
  let result: boolean | undefined;
  program.traverse({
    ClassProperty(path) {
      if (path.node.static)
        result = isClosedFreshAllocationFactory(path.get("value"));
    }
  });
  expect(result).toBe(false);
});

it("does not resolve a heritage private read to the new class's same-name field", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    `class Outer {#brand; static factory=()=>({test:value=>{class Local extends (#brand in value ? class {} : class {}) {#brand;} return Local;}});}`
  );
  let result: boolean | undefined;
  program.traverse({
    ClassProperty(path) {
      if (path.node.static)
        result = isClosedFreshAllocationFactory(path.get("value"));
    }
  });
  expect(result).toBe(false);
});

it("represents absent own shape fields explicitly", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "const factory=()=>({})"
  );
  const binding = program.scope.getBinding("factory")!;
  if (!binding.path.isVariableDeclarator()) throw Error("factory");
  const shape = describeClosedOwnAllocationFactory(binding.path.get("init"))!;
  if (shape.kind !== "object") throw Error("object");
  expect(shape.properties.missing).toBeUndefined();
  // @ts-expect-error Own-field dictionaries are partial, even without noUncheckedIndexedAccess.
  const invalid: import("./closedAllocation.js").ClosedOwnAllocationShape =
    shape.properties.missing;
  expect(invalid).toBeUndefined();
});

it("represents out-of-bounds own array shape entries explicitly", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "const factory=()=>[1]"
  );
  const binding = program.scope.getBinding("factory")!;
  if (!binding.path.isVariableDeclarator()) throw Error("factory");
  const shape = describeClosedOwnAllocationFactory(binding.path.get("init"))!;
  if (shape.kind !== "array") throw Error("array");
  expect(shape.elements[0]?.kind).toBe("primitive");
  expect(shape.elements[1]).toBeUndefined();
  // @ts-expect-error An arbitrary index can be absent even without noUncheckedIndexedAccess.
  const invalid: import("./closedAllocation.js").ClosedOwnAllocationShape =
    shape.elements[1];
  expect(invalid).toBeUndefined();
});
