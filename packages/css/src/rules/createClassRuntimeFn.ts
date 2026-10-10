import type {
  ClassRuntimeConfig,
  RecipeClassNames,
  ClassRuntimeFn,
  VariantGroups,
  VariantSelection,
  VariantObjectSelection
} from "./types.js";
import { mapValues, transformVariantSelection } from "./utils.js";
import { RuntimeCache } from "../runtime/cache.js";

// Cache only enough repeated work to pay for normalization and key lookups.
const cacheMinimumWork = 32;
const cacheWarmupCalls = 8;
const cacheSampleCalls = 64;
const cacheMinimumHits = 16;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const shouldApplyCompound = <Variants extends VariantGroups>(
  compoundCheck: VariantObjectSelection<Variants>,
  selections: VariantObjectSelection<Variants>,
  defaultVariants: VariantObjectSelection<Variants>
) => {
  for (const key of Object.keys(compoundCheck)) {
    if (compoundCheck[key] !== (selections[key] ?? defaultVariants[key])) {
      return false;
    }
  }

  return true;
};

/* @__NO_SIDE_EFFECTS__ */
export const createClassRuntimeFn = <Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>
): ClassRuntimeFn<Variants> => {
  const runtimeFn = (options: Parameters<ClassRuntimeFn<Variants>>[0]) => {
    let className = config.defaultClassName;

    const selections: VariantObjectSelection<Variants> = {
      ...config.defaultVariants,
      ...transformVariantSelection<Variants>(
        options as VariantSelection<Variants>
      )
    };

    // Declaration order is shared by runtime calls and compiler evaluation.
    for (const variantName of Object.keys(config.variantClassNames)) {
      if (!hasOwn(selections, variantName)) continue;

      const variantSelection =
        selections[variantName] ?? config.defaultVariants[variantName];

      if (variantSelection != null) {
        let selection = variantSelection;

        if (typeof selection === "boolean") {
          // @ts-expect-error - Needed to convert boolean to string
          selection = selection === true ? "true" : "false";
        }

        const selectionClassName =
          config.variantClassNames[variantName]?.[selection as string];

        if (selectionClassName) {
          className += " " + selectionClassName;
        }
      }
    }

    for (const [compoundCheck, compoundClassName] of config.compoundVariants) {
      if (
        shouldApplyCompound(compoundCheck, selections, config.defaultVariants)
      ) {
        className += " " + compoundClassName;
      }
    }

    return className;
  };

  return attachRuntimeProperties(config, runtimeFn);
};

/** Compiler-only factory: serialized config is private and immutable. */
/* @__NO_SIDE_EFFECTS__ */
export const createCompiledClassRuntimeFn = <Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>,
  features?: ClassRuntimeFeatures
): ClassRuntimeFn<Variants> => {
  let prepared: PreparedRecipe | undefined;
  let cache: RecipeCacheState | undefined;
  let calls = 0;
  let cacheDisabled = false;

  const runtimeFn = (options: Parameters<ClassRuntimeFn<Variants>>[0]) => {
    // Read every own input value before consulting caches, including unused keys.
    const selections: VariantObjectSelection<Variants> = {
      ...config.defaultVariants,
      ...transformVariantSelection<Variants>(
        options as VariantSelection<Variants>
      )
    };

    prepared ??= prepareRecipe(config);

    let cacheKey: string | undefined;

    if (
      prepared.cacheEligible &&
      !cacheDisabled &&
      ++calls > cacheWarmupCalls
    ) {
      cache ??= {
        prepared: prepareRecipeCache(config, prepared),
        results: new RuntimeCache(),
        samples: 0,
        hits: 0
      };
      cacheKey = getRecipeCacheKey(
        cache.prepared,
        selections,
        config.defaultVariants
      );

      const cached =
        cacheKey === undefined ? undefined : cache.results.get(cacheKey);

      cache.samples += 1;

      if (cached !== undefined) cache.hits += 1;

      if (cache.samples === cacheSampleCalls) {
        if (cache.hits < cacheMinimumHits) {
          cache.results.clear();
          cache = undefined;
          cacheDisabled = true;
        } else {
          cache.samples = 0;
          cache.hits = 0;
        }
      }

      if (cached !== undefined) return cached;
    }

    let className = config.defaultClassName;

    for (const variantName of prepared.variantNames) {
      if (!hasOwn(selections, variantName)) continue;

      const selection =
        selections[variantName] ?? config.defaultVariants[variantName];
      if (selection == null) continue;

      const selectedClass =
        config.variantClassNames[variantName]?.[selection as string];

      if (selectedClass) className += " " + selectedClass;
    }

    for (let index = 0; index < config.compoundVariants.length; index += 1) {
      const [check, compoundClass] = config.compoundVariants[index];
      let matches = true;

      for (const name of prepared.compoundKeys[index]) {
        if (
          check[name] !== (selections[name] ?? config.defaultVariants[name])
        ) {
          matches = false;
          break;
        }
      }

      if (matches) className += " " + compoundClass;
    }

    if (cacheKey !== undefined)
      cache?.results.set(cacheKey, className, className.length);

    return className;
  };

  return attachRuntimeProperties(config, runtimeFn, true, features);
};

/** Internal compiler proof: omitted methods must have no observable use. */
export interface ClassRuntimeFeatures {
  variants?: boolean;
  classNames?: boolean;
}

type PreparedRecipe = {
  variantNames: string[];
  compoundKeys: string[][];
  cacheEligible: boolean;
};

type PreparedRecipeCache = {
  selectionNames: string[];
  tableDomains?: Map<unknown, number>[];
};

type RecipeCacheState = {
  prepared: PreparedRecipeCache;
  results: RuntimeCache<string>;
  samples: number;
  hits: number;
};

function prepareRecipe<Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>
): PreparedRecipe {
  const variantNames = Object.keys(config.variantClassNames);
  const compoundKeys = config.compoundVariants.map(([check]) =>
    Object.keys(check)
  );

  const work = compoundKeys.reduce(
    (count, keys) => count + keys.length,
    variantNames.length + compoundKeys.length
  );

  return {
    variantNames,
    compoundKeys,
    cacheEligible: work >= cacheMinimumWork
  };
}

function prepareRecipeCache<Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>,
  { variantNames, compoundKeys }: PreparedRecipe
): PreparedRecipeCache {
  const selectionNames = [
    ...new Set([...variantNames, ...compoundKeys.flat()])
  ];

  const tableDomains: Map<unknown, number>[] = [];
  let states = 1;

  for (const name of selectionNames) {
    const values = new Set<unknown>([undefined]);

    if (hasOwn(config.defaultVariants, name))
      values.add(config.defaultVariants[name]);

    const classes = hasOwn(config.variantClassNames, name)
      ? config.variantClassNames[name]
      : undefined;

    for (const value of Object.keys(classes ?? {})) {
      values.add(value);

      if (value === "true" || value === "false") values.add(value === "true");
      if (String(Number(value)) === value) values.add(Number(value));
    }

    for (const [check] of config.compoundVariants) {
      if (hasOwn(check, name)) values.add(check[name]);
    }

    if ([...values].some((value) => !isCacheableSelection(value))) {
      return { selectionNames };
    }

    states *= values.size;

    if (states > 256) {
      return { selectionNames };
    }

    tableDomains.push(
      new Map([...values].map((value, index) => [value, index]))
    );
  }

  return { selectionNames, tableDomains };
}

function getRecipeCacheKey(
  prepared: PreparedRecipeCache,
  selections: Record<string, unknown>,
  defaults: Record<string, unknown>
): string | undefined {
  if (prepared.tableDomains !== undefined) {
    let tableIndex = 0;
    let tableMatch = true;

    for (let index = 0; index < prepared.selectionNames.length; index += 1) {
      const name = prepared.selectionNames[index];

      // Inherited getters are observable on each lookup, including compounds.
      // Keep the ordinary path when a relevant prototype property is present.
      if (name in Object.prototype) return undefined;

      const domain = prepared.tableDomains[index];
      const value = selections[name] ?? defaults[name];
      const valueIndex = domain.get(value);

      if (valueIndex === undefined) {
        tableMatch = false;
        break;
      }

      if (value != null && String(value) in Object.prototype) return undefined;

      tableIndex = tableIndex * domain.size + valueIndex;
    }

    if (tableMatch) return `t:${tableIndex}`;
  }

  let key = "v:";

  for (let index = 0; index < prepared.selectionNames.length; index += 1) {
    const name = prepared.selectionNames[index];
    if (name in Object.prototype) return undefined;

    const value = selections[name] ?? defaults[name];
    if (!isCacheableSelection(value)) return undefined;

    const type = typeof value;
    const text = String(value);
    if (value != null && text in Object.prototype) return undefined;

    key += `${type[0]}${text.length}:${text}`;
  }

  return key;
}

function isCacheableSelection(value: unknown): boolean {
  const type = typeof value;

  return (
    value === null ||
    type === "undefined" ||
    type === "string" ||
    type === "number" ||
    type === "boolean"
  );
}

function attachRuntimeProperties<Variants extends VariantGroups>(
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
