import {
  createCompactClassRuntimeFn,
  createCompactRuntimeFn
} from "./createCompactRuntimeFn.js";
import { unpackRecipe, type PackedRecipe } from "./packedRecipe.js";

/* @__NO_SIDE_EFFECTS__ */
export const createPackedCompactClassRuntimeFn = (
  payload: PackedRecipe,
  features?: Parameters<typeof createCompactClassRuntimeFn>[1]
) =>
  createCompactClassRuntimeFn(
    unpackRecipe(payload) as Parameters<typeof createCompactClassRuntimeFn>[0],
    features
  );

/* @__NO_SIDE_EFFECTS__ */
export const createPackedCompactRuntimeFn = (
  payload: PackedRecipe,
  props: Parameters<typeof createCompactRuntimeFn>[1],
  features?: Parameters<typeof createCompactRuntimeFn>[2]
) =>
  createCompactRuntimeFn(
    unpackRecipe(payload) as Parameters<typeof createCompactRuntimeFn>[0],
    props,
    features
  );
