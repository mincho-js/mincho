import type { FileScope } from "@vanilla-extract/css";
import {
  endFileScope,
  getFileScope,
  hasFileScope,
  setFileScope
} from "@vanilla-extract/css/fileScope";
import type {
  DefineRulesCtx,
  DefineRulesPresetMap,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

type NormalizedDefineRulesRegistryFileScope = {
  packageName: string;
  filePath: string;
};

export interface DefineRulesRegistryInstance {
  registrationId: string;
  fileScope: NormalizedDefineRulesRegistryFileScope;
  registrationIndex: number;
  config: unknown;
  presetArtifact: DefineRulesPresetMap;
  getPresetSnapshot(): DefineRulesPresetMap;
}

export interface DefineRulesRegistrySession {
  instances: DefineRulesRegistryInstance[];
  nextRegistrationIndex: number;
  nextRegistrationIndexByFileScope: Record<string, number>;
}

const DEFINE_RULES_REGISTRY_STACK = Symbol.for(
  "@mincho-js/css/defineRulesRegistry"
);

type DefineRulesRegistryGlobal = typeof globalThis & {
  [DEFINE_RULES_REGISTRY_STACK]?: DefineRulesRegistrySession[];
};

function getRegistryStack(): DefineRulesRegistrySession[] {
  const registryGlobal = globalThis as DefineRulesRegistryGlobal;
  const stack = registryGlobal[DEFINE_RULES_REGISTRY_STACK];

  if (stack != null) {
    return stack;
  }

  const nextStack: DefineRulesRegistrySession[] = [];
  registryGlobal[DEFINE_RULES_REGISTRY_STACK] = nextStack;
  return nextStack;
}

function clearRegistryStackIfEmpty(): void {
  const registryGlobal = globalThis as DefineRulesRegistryGlobal;
  const stack = registryGlobal[DEFINE_RULES_REGISTRY_STACK];

  if (stack != null && stack.length === 0) {
    delete registryGlobal[DEFINE_RULES_REGISTRY_STACK];
  }
}

export function beginDefineRulesRegistrySession(): DefineRulesRegistrySession {
  const session: DefineRulesRegistrySession = {
    instances: [],
    nextRegistrationIndex: 0,
    nextRegistrationIndexByFileScope: {}
  };

  getRegistryStack().push(session);
  return session;
}

export function endDefineRulesRegistrySession():
  | DefineRulesRegistrySession
  | undefined {
  const registryGlobal = globalThis as DefineRulesRegistryGlobal;
  const stack = registryGlobal[DEFINE_RULES_REGISTRY_STACK];
  const session = stack?.pop();

  clearRegistryStackIfEmpty();
  return session;
}

export function getActiveDefineRulesRegistrySession():
  | DefineRulesRegistrySession
  | undefined {
  const registryGlobal = globalThis as DefineRulesRegistryGlobal;
  const stack = registryGlobal[DEFINE_RULES_REGISTRY_STACK];

  if (stack == null || stack.length === 0) {
    return undefined;
  }

  return stack[stack.length - 1];
}

export function normalizeDefineRulesRegistryFileScope(
  fileScope: FileScope
): NormalizedDefineRulesRegistryFileScope {
  return {
    packageName: fileScope.packageName ?? "<root>",
    filePath: fileScope.filePath.replace(/\\/g, "/")
  };
}

export function registerDefineRulesRegistryInstance<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(metadata: {
  config: DefineRulesCtx<Properties, Shortcuts>;
  presetArtifact: DefineRulesPresetMap;
  getPresetSnapshot(): DefineRulesPresetMap;
}): DefineRulesRegistryInstance | undefined {
  const session = getActiveDefineRulesRegistrySession();

  if (session == null) {
    return undefined;
  }

  if (hasFileScope() === false) {
    throw new Error(
      "defineRules registry serialization requires an active fileScope"
    );
  }

  const fileScope = normalizeDefineRulesRegistryFileScope(getFileScope());
  const fileScopeId = `${fileScope.packageName}:${fileScope.filePath}`;
  const registrationIndex =
    session.nextRegistrationIndexByFileScope[fileScopeId] ?? 0;
  const registrationId = `${fileScopeId}#defineRules:${registrationIndex}`;
  const instance: DefineRulesRegistryInstance = {
    registrationId,
    fileScope,
    registrationIndex,
    config: metadata.config,
    presetArtifact: metadata.presetArtifact,
    getPresetSnapshot: metadata.getPresetSnapshot
  };

  session.nextRegistrationIndex += 1;
  session.nextRegistrationIndexByFileScope[fileScopeId] =
    registrationIndex + 1;
  session.instances.push(instance);
  return instance;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, afterEach } = import.meta.vitest;

  const createRegistryMetadata = (preset: DefineRulesPresetMap = {}) => {
    const presetArtifact: DefineRulesPresetMap = preset;

    return {
      config: {
        debugId: "registry",
        properties: {
          color: true
        }
      } as const,
      presetArtifact,
      getPresetSnapshot: () => ({
        ...preset
      })
    };
  };

  afterEach(() => {
    while (getActiveDefineRulesRegistrySession() != null) {
      endDefineRulesRegistrySession();
    }

    while (hasFileScope()) {
      endFileScope();
    }
  });

  describe("defineRules registry", () => {
    it("is a runtime no-op without an active registry session", () => {
      expect(
        registerDefineRulesRegistryInstance(createRegistryMetadata())
      ).toBe(undefined);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("registers deterministic IDs from the active fileScope", () => {
      const session = beginDefineRulesRegistrySession();
      setFileScope("src/a.css.ts", "pkg");

      const firstInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );
      const secondInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      expect(firstInstance?.registrationId).toBe(
        "pkg:src/a.css.ts#defineRules:0"
      );
      expect(secondInstance?.registrationId).toBe(
        "pkg:src/a.css.ts#defineRules:1"
      );
      expect(session.instances).toEqual([firstInstance, secondInstance]);
      expect(
        session.instances.map((instance) => instance.registrationIndex)
      ).toEqual([0, 1]);
      expect(session.nextRegistrationIndex).toBe(2);
      expect(session.nextRegistrationIndexByFileScope).toEqual({
        "pkg:src/a.css.ts": 2
      });
    });

    it("keeps registration indexes stable per fileScope", () => {
      const session = beginDefineRulesRegistrySession();
      setFileScope("src/a.css.ts", "pkg");
      const firstAInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      endFileScope();
      setFileScope("src/b.css.ts", "pkg");
      const firstBInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      endFileScope();
      setFileScope("src/a.css.ts", "pkg");
      const secondAInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      expect(
        session.instances.map((instance) => instance.registrationId)
      ).toEqual([
        "pkg:src/a.css.ts#defineRules:0",
        "pkg:src/b.css.ts#defineRules:0",
        "pkg:src/a.css.ts#defineRules:1"
      ]);
      expect(
        session.instances.map((instance) => instance.registrationIndex)
      ).toEqual([0, 0, 1]);
      expect(session.instances).toEqual([
        firstAInstance,
        firstBInstance,
        secondAInstance
      ]);
      expect(session.nextRegistrationIndex).toBe(3);
      expect(session.nextRegistrationIndexByFileScope).toEqual({
        "pkg:src/a.css.ts": 2,
        "pkg:src/b.css.ts": 1
      });
    });

    it("normalizes root package scopes and Windows file paths", () => {
      const normalizedFileScope = normalizeDefineRulesRegistryFileScope({
        filePath: "src\\a.css.ts"
      });

      expect(normalizedFileScope).toEqual({
        packageName: "<root>",
        filePath: "src/a.css.ts"
      });

      beginDefineRulesRegistrySession();
      setFileScope("src\\a.css.ts");

      const instance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      expect(instance?.registrationId).toBe(
        "<root>:src/a.css.ts#defineRules:0"
      );
      expect(instance?.fileScope).toEqual(normalizedFileScope);
    });

    it("keeps nested sessions isolated and restores the previous active session", () => {
      const outerSession = beginDefineRulesRegistrySession();
      setFileScope("outer.css.ts", "pkg");
      const outerFirstInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      const innerSession = beginDefineRulesRegistrySession();
      setFileScope("inner.css.ts", "pkg");
      const innerInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      expect(getActiveDefineRulesRegistrySession()).toBe(innerSession);
      expect(innerInstance?.registrationId).toBe(
        "pkg:inner.css.ts#defineRules:0"
      );
      expect(endDefineRulesRegistrySession()).toBe(innerSession);
      endFileScope();
      expect(getActiveDefineRulesRegistrySession()).toBe(outerSession);

      const outerSecondInstance = registerDefineRulesRegistryInstance(
        createRegistryMetadata()
      );

      expect(outerFirstInstance?.registrationId).toBe(
        "pkg:outer.css.ts#defineRules:0"
      );
      expect(outerSecondInstance?.registrationId).toBe(
        "pkg:outer.css.ts#defineRules:1"
      );
      expect(outerSession.instances).toEqual([
        outerFirstInstance,
        outerSecondInstance
      ]);
      expect(innerSession.instances).toEqual([innerInstance]);
      expect(outerSession.nextRegistrationIndex).toBe(2);
      expect(innerSession.nextRegistrationIndex).toBe(1);
      expect(outerSession.nextRegistrationIndexByFileScope).toEqual({
        "pkg:outer.css.ts": 2
      });
      expect(innerSession.nextRegistrationIndexByFileScope).toEqual({
        "pkg:inner.css.ts": 1
      });
    });

    it("restores the outer session when evaluation cleanup runs after a throw", () => {
      const outerSession = beginDefineRulesRegistrySession();
      const innerSession = beginDefineRulesRegistrySession();

      expect(() => {
        try {
          throw new Error("evaluation failed");
        } finally {
          expect(endDefineRulesRegistrySession()).toBe(innerSession);
        }
      }).toThrow("evaluation failed");

      expect(getActiveDefineRulesRegistrySession()).toBe(outerSession);
      expect(endDefineRulesRegistrySession()).toBe(outerSession);
      expect(getActiveDefineRulesRegistrySession()).toBe(undefined);
    });

    it("throws a diagnostic when an active session has no fileScope", () => {
      const session = beginDefineRulesRegistrySession();

      expect(() =>
        registerDefineRulesRegistryInstance(createRegistryMetadata())
      ).toThrow(
        "defineRules registry serialization requires an active fileScope"
      );
      expect(session.instances).toEqual([]);
      expect(session.nextRegistrationIndex).toBe(0);
      expect(session.nextRegistrationIndexByFileScope).toEqual({});
    });

    it("stores live preset artifact references and defers snapshot reads", () => {
      const session = beginDefineRulesRegistrySession();
      setFileScope("live.css.ts", "pkg");
      const preset: DefineRulesPresetMap = {};
      let snapshotReadCount = 0;
      const metadata = createRegistryMetadata(preset);
      const getPresetSnapshot = () => {
        snapshotReadCount += 1;
        return {
          ...preset
        };
      };

      const instance = registerDefineRulesRegistryInstance({
        ...metadata,
        getPresetSnapshot
      });

      preset.colorRed = "color_red";

      expect(instance?.presetArtifact).toBe(metadata.presetArtifact);
      expect(instance?.config).toBe(metadata.config);
      expect(snapshotReadCount).toBe(0);
      expect(instance?.getPresetSnapshot()).toEqual({
        colorRed: "color_red"
      });
      expect(snapshotReadCount).toBe(1);
      expect(session.instances[0]).toBe(instance);
    });
  });
}
