import { parseArgs } from "node:util";
import { createCompiledClassRuntimeFn } from "@mincho-js/css/rules/createClassRuntimeFn";
import { createCompactClassRuntimeFn } from "@mincho-js/css/rules/createCompactRuntimeFn";

const { values } = parseArgs({
  options: { profile: { type: "string", default: "baseline" } }
});
const config = {
  defaultClassName: "base",
  variantClassNames: {
    size: { small: "small", large: "large" },
    active: { true: "active", false: "inactive" }
  },
  defaultVariants: { size: "small" },
  compoundVariants: [[{ size: "large", active: true }, "compound"]]
};
const factory =
  values.profile === "candidate"
    ? createCompactClassRuntimeFn
    : createCompiledClassRuntimeFn;
const recipe = factory(config);
const selections = [
  {},
  { size: "small", active: false },
  { size: "large", active: true },
  { size: null, active: true }
];
let checksum = 0;
for (let i = 0; i < 20000; i++)
  checksum += recipe(selections[i % selections.length]).length;
const start = performance.now(),
  cpu = process.cpuUsage();
const iterations = 300000;
for (let i = 0; i < iterations; i++)
  checksum += recipe(selections[i % selections.length]).length;
console.log(
  JSON.stringify({
    profile: values.profile,
    iterations,
    checksum,
    milliseconds: performance.now() - start,
    cpu: process.cpuUsage(cpu)
  })
);
