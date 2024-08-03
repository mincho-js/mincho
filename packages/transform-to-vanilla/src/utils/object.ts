import deepmerge from "@fastify/deepmerge";

// Export type error issue
// https://github.com/fastify/deepmerge/issues/12
export const mergeObject = deepmerge() as <
  T1 extends object,
  T2 extends object
>(
  target: T1,
  source: T2
) => T1 & T2;

export function isEmptyObject(obj: object) {
  return Object.keys(obj).length === 0;
}
