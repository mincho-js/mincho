import { createCompiledClassRuntimeFn } from "./createClassRuntimeFn.js";
import { createCompiledRuntimeFn } from "./createRuntimeFn.js";
import { unpackRecipe, type PackedRecipe } from "./packedRecipe.js";

/* @__NO_SIDE_EFFECTS__ */
export const createPackedClassRuntimeFn = (
  payload: PackedRecipe,
  features?: Parameters<typeof createCompiledClassRuntimeFn>[1]
) =>
  createCompiledClassRuntimeFn(
    unpackRecipe(payload) as Parameters<typeof createCompiledClassRuntimeFn>[0],
    features
  );

/* @__NO_SIDE_EFFECTS__ */
export const createPackedRuntimeFn = (
  payload: PackedRecipe,
  props: Parameters<typeof createCompiledRuntimeFn>[1],
  features?: Parameters<typeof createCompiledRuntimeFn>[2]
) =>
  createCompiledRuntimeFn(
    unpackRecipe(payload) as Parameters<typeof createCompiledRuntimeFn>[0],
    props,
    features
  );
