import { first, second, mutate, finish } from "./provider";

const left = first();
const right = second();
const changed = mutate(left, right);
export const output = finish(left, right, changed);
