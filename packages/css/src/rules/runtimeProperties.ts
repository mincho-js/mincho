import type {
  ClassRuntimeConfig,
  ClassRuntimeFn,
  RecipeClassNames,
  VariantGroups
} from "./types.js";
import { mapValues } from "./utils.js";

/** Internal compiler proof: omitted methods must have no observable use. */
export interface ClassRuntimeFeatures {
  variants?: boolean;
  classNames?: boolean;
}

export function attachRuntimeProperties<Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>,
  callable: (options: Parameters<ClassRuntimeFn<Variants>>[0]) => string,
  compiled = false,
  features?: ClassRuntimeFeatures
): ClassRuntimeFn<Variants> {
  const runtimeFn = callable as ClassRuntimeFn<Variants>;

  let variantNames: (keyof Variants)[] | undefined;
  let variantClasses: RecipeClassNames<Variants>["variants"] | undefined;
  let baseClass: string | undefined;

  if (features?.variants !== false) {
    runtimeFn.variants = compiled
      ? () => (variantNames ??= Object.keys(config.variantClassNames)).slice()
      : () => Object.keys(config.variantClassNames);
  }

  if (features?.classNames !== false)
    runtimeFn.classNames = {
      get base() {
        return compiled
          ? (baseClass ??= config.defaultClassName.split(" ")[0])
          : config.defaultClassName.split(" ")[0];
      },

      get variants() {
        const getClasses = () =>
          mapValues(config.variantClassNames, (classNames) =>
            mapValues(classNames, (className) => className.split(" ")[0])
          ) as RecipeClassNames<Variants>["variants"];

        return compiled
          ? (mapValues((variantClasses ??= getClasses()), (classNames) => ({
              ...classNames
            })) as RecipeClassNames<Variants>["variants"])
          : getClasses();
      }
    };

  return runtimeFn;
}
