import type { MessagePort } from "node:worker_threads";
import type {
  BabelTransformSourceOptions,
  StaticCssEvalSourceProvider
} from "./babel.js";
import type { ScopedDependencyOptions } from "./compile.js";
import type { TransformSnapshot } from "./transformSnapshot.js";
import type {
  CompilerPayloadReference,
  CompilerSourcePayload
} from "./compilerPayload.js";

export type CompilerJob = {
  environment: string;
  generation: number;
  cache: boolean;
  cachePartitions: number;
  port: MessagePort;
  sourcePayload?: CompilerSourcePayload;
  batchProviderRequests?: boolean;
} & (
  | { kind: "transform"; input: BabelTransformSourceOptions; provider: boolean }
  | { kind: "scoped"; input: ScopedDependencyOptions }
);

export type ProviderRequestMessage =
  | {
      kind: "resolve";
      args: Parameters<StaticCssEvalSourceProvider["resolve"]>;
    }
  | { kind: "load"; args: Parameters<StaticCssEvalSourceProvider["load"]> }
  | { kind: "payload"; reference: CompilerPayloadReference };

export type ProviderRequest = { id: number } & ProviderRequestMessage;

export interface CompilerTransportMetrics {
  protocol: string;
  payloadHits: number;
  payloadMisses: number;
  payloadBytes: number;
  providerRequests: number;
  providerBatches: number;
}

export interface ProviderBatch {
  kind: "batch";
  requests: ProviderRequest[];
}

export interface WorkerFailure {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  file?: string;
  dependencies?: readonly string[];
  cause?: WorkerFailure;
  transform?: TransformSnapshot;
}

export type ProviderResponse = { id: number } & (
  | { ok: true; value: unknown }
  | { ok: false; error: WorkerFailure }
);

export type CompilerResponse = {
  duration: number;
  transport?: CompilerTransportMetrics;
} & (
  | { ok: true; value: string | TransformSnapshot }
  | { ok: false; error: WorkerFailure }
);

export function serializeWorkerError(
  error: unknown,
  seen = new Set<unknown>()
): WorkerFailure {
  seen.add(error);

  const value = error as Error & {
    code?: string;
    file?: string;
    dependencies?: readonly string[];
  };

  return {
    name: value?.name ?? "Error",
    message: value?.message ?? String(error),
    stack: value?.stack,
    code: value?.code,
    file: value?.file,
    dependencies: value?.dependencies,
    ...(value?.cause && !seen.has(value.cause) && seen.size < 8
      ? { cause: serializeWorkerError(value.cause, seen) }
      : {})
  };
}

export function restoreWorkerError(value: WorkerFailure): Error {
  const error = Object.assign(
    new Error(
      value.message,
      value.cause ? { cause: restoreWorkerError(value.cause) } : undefined
    ),
    {
      name: value.name,
      ...(value.code ? { code: value.code } : {}),
      ...(value.file ? { file: value.file } : {}),
      ...(value.dependencies ? { dependencies: value.dependencies } : {})
    }
  );

  if (value.stack) error.stack = value.stack;

  return error;
}
