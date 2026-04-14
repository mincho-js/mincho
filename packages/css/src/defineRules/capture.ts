import type { DefineRulesPresetMap } from "./types.js";

export const DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX =
  "__MINCHO_DEFINE_RULES_SENTINEL__:";

export interface DefineRulesPresetCaptureInstance {
  sentinelId: string;
  filePath: string;
  instanceIndex: number;
  getPresetSnapshot(): DefineRulesPresetMap;
}

export interface DefineRulesPresetCaptureSession {
  filePath: string;
  instances: DefineRulesPresetCaptureInstance[];
}

const DEFINE_RULES_PRESET_CAPTURE_STACK = Symbol.for(
  "@mincho-js/css/defineRulesPresetCapture"
);

type DefineRulesPresetCaptureGlobal = typeof globalThis & {
  [DEFINE_RULES_PRESET_CAPTURE_STACK]?: DefineRulesPresetCaptureSession[];
};

function getCaptureStack(): DefineRulesPresetCaptureSession[] {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const stack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];

  if (stack != null) {
    return stack;
  }

  const nextStack: DefineRulesPresetCaptureSession[] = [];
  captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK] = nextStack;
  return nextStack;
}

function clearCaptureStackIfEmpty(): void {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const stack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];

  if (stack != null && stack.length === 0) {
    delete captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];
  }
}

export function beginDefineRulesPresetCapture(
  filePath: string
): DefineRulesPresetCaptureSession {
  const session: DefineRulesPresetCaptureSession = {
    filePath,
    instances: []
  };

  getCaptureStack().push(session);
  return session;
}

export function endDefineRulesPresetCapture():
  | DefineRulesPresetCaptureSession
  | undefined {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const stack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];
  const session = stack?.pop();

  clearCaptureStackIfEmpty();
  return session;
}

export function getActiveDefineRulesPresetCapture():
  | DefineRulesPresetCaptureSession
  | undefined {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const stack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];

  if (stack == null || stack.length === 0) {
    return undefined;
  }

  return stack[stack.length - 1];
}

export function getDefineRulesPresetCaptureSentinelId(
  value: unknown
): string | undefined {
  if (
    typeof value !== "string" ||
    value.startsWith(DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX) === false
  ) {
    return undefined;
  }

  const sentinelId = value.slice(
    DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX.length
  );
  return sentinelId.length > 0 ? sentinelId : undefined;
}

export function registerDefineRulesPresetCaptureInstance(
  sentinelValue: unknown,
  getPresetSnapshot: () => DefineRulesPresetMap
): DefineRulesPresetCaptureInstance | undefined {
  const session = getActiveDefineRulesPresetCapture();
  const sentinelId = getDefineRulesPresetCaptureSentinelId(sentinelValue);

  if (session == null || sentinelId == null) {
    return undefined;
  }

  const instance: DefineRulesPresetCaptureInstance = {
    sentinelId,
    filePath: session.filePath,
    instanceIndex: session.instances.length,
    getPresetSnapshot
  };

  session.instances.push(instance);
  return instance;
}
