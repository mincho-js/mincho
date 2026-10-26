import type {
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";
import { createDefineRulesRuntime } from "./runtime.js";
import { defineRulesDefinition } from "./extension.js";
import {
  getActiveDefineRulesRegistrySession,
  type DefineRulesRegistrySession
} from "./registry.js";
import {
  compilePrivateDefineRulesClass,
  registerCompilerClassMethod
} from "./compilerClasses.js";

export const createDefineRulesCssRuntime = <
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  const Context = undefined
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>
) => {
  type CssRuntime = ReturnType<
    typeof createDefineRulesRuntime<Properties, Shortcuts, Conditions, Context>
  >["css"];
  const sessionRuntimes = new WeakMap<DefineRulesRegistrySession, CssRuntime>();
  let unregisteredRuntime: CssRuntime | undefined;

  function getUnregisteredRuntime(): CssRuntime {
    return (unregisteredRuntime ??= createDefineRulesRuntime(config, {
      registerPreset: false
    }).css);
  }

  // Imported definitions initialize in the producer module's scope. Register
  // on use and isolate style caches, origins and snapshots by consumer session.
  function getRuntime(): CssRuntime {
    const session = getActiveDefineRulesRegistrySession();
    if (session === undefined) return getUnregisteredRuntime();

    let runtime = sessionRuntimes.get(session);
    if (runtime === undefined) {
      runtime = createDefineRulesRuntime(config).css;
      sessionRuntimes.set(session, runtime);
    }
    return runtime;
  }

  const css = Object.assign((args: never) => getRuntime()(args), {
    raw: (args: never) => getUnregisteredRuntime().raw(args)
  }) as CssRuntime;
  Object.defineProperty(css, defineRulesDefinition, { value: config });
  registerCompilerClassMethod(css, (args, strategy) =>
    compilePrivateDefineRulesClass(getRuntime(), args, strategy)
  );
  return css;
};
