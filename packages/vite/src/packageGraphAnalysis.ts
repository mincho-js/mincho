import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import type { DefineRulesPackageGraph } from "@mincho-js/integration/package-graph";
import {
  analyzeRegisteredPackageGraphs,
  restorePackageGraphError,
  type PackageGraphAnalysisRequest,
  type PackageGraphAnalysisResult,
  type PackageGraphWorkerCommand,
  type PackageGraphWorkerResponse
} from "./packageGraphAnalysisCore.js";

export type {
  PackageGraphAnalysisRequest,
  PackageGraphAnalysisResult
} from "./packageGraphAnalysisCore.js";

export type PackageGraphAnalysisMode = "auto" | "worker" | "inline";

export interface PackageGraphAnalysisOptions {
  readonly mode?: PackageGraphAnalysisMode;
  readonly onAnalysis?: (mode: "worker" | "inline", bytes: number) => void;
  readonly schedule?: (
    bytes: number,
    worker: () => Promise<PackageGraphAnalysisResult>,
    inline: () => Promise<PackageGraphAnalysisResult>
  ) => Promise<PackageGraphAnalysisResult>;
}

export interface PackageGraphAnalysis {
  /** Clears module records and invalidates pending requests from older builds. */
  beginGeneration(): number;

  /** Obsolete asynchronous registrations are ignored and return false. */
  register(options: {
    readonly generation: number;
    readonly moduleId: string;
    readonly graph: DefineRulesPackageGraph;
  }): boolean;

  remove(options: {
    readonly generation: number;
    readonly moduleId: string;
  }): boolean;

  /** Missing records denote ordinary modules without a Mincho package graph. */
  analyze(
    request: PackageGraphAnalysisRequest
  ): Promise<PackageGraphAnalysisResult>;

  /** Terminal and idempotent; watch builds should close only when watching ends. */
  close(): Promise<void>;
}

interface PendingAnalysis {
  readonly generation: number;
  readonly resolve: (result: PackageGraphAnalysisResult) => void;
  readonly reject: (error: Error) => void;
}

function staleGenerationError(): Error {
  const error = new Error(
    "Package graph analysis generation is no longer current"
  );

  error.name = "PackageGraphAnalysisStaleGenerationError";

  return error;
}

function closedError(): Error {
  const error = new Error("Package graph analysis is closed");
  error.name = "PackageGraphAnalysisClosedError";

  return error;
}

function workerFileName(): string {
  // Rollup rewrites this URL for the CommonJS runtime artifact.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: declaration builds also check this source with a CommonJS target.
  const moduleFile = fileURLToPath(import.meta.url);
  const extension = extname(moduleFile);

  // Source-level tests use the same worker artifact as installed consumers.
  // The workspace test pipeline builds this entry before running those tests.
  if (extension === ".ts") {
    return join(dirname(moduleFile), "../dist/esm/packageGraphWorker.mjs");
  }

  return join(
    dirname(moduleFile),
    `packageGraphWorker${extension === ".cjs" ? ".cjs" : ".mjs"}`
  );
}

export function createPackageGraphAnalysis(
  options: PackageGraphAnalysisOptions = {}
): PackageGraphAnalysis {
  const mode = options.mode ?? "auto";
  if (mode !== "auto" && mode !== "worker" && mode !== "inline") {
    throw new TypeError(
      "Package graph analysis mode must be auto, worker or inline"
    );
  }

  const graphs = new Map<string, DefineRulesPackageGraph>();
  const sizes = new Map<string, number>();
  const pending = new Map<number, PendingAnalysis>();
  let generation = 0;
  let requestId = 0;
  let revision = 0;
  let worker: NodeWorker | undefined;
  let workerFailure: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);

    pending.clear();
    worker?.unref();
  };

  const failWorker = (instance: NodeWorker, error: unknown): void => {
    if (worker !== instance || closed) return;

    worker = undefined;
    workerFailure = error instanceof Error ? error : new Error(String(error));
    rejectPending(workerFailure);
    void instance.terminate();
  };

  const finish = (response: PackageGraphWorkerResponse): void => {
    const request = pending.get(response.requestId);
    if (request === undefined) return;

    pending.delete(response.requestId);

    if (
      response.generation !== generation ||
      request.generation !== generation
    ) {
      request.reject(staleGenerationError());
    } else if (response.type === "error") {
      request.reject(restorePackageGraphError(response.error));
    } else {
      request.resolve(response.result);
    }

    if (pending.size === 0) worker?.unref();
  };

  const ensureWorker = (): NodeWorker => {
    if (workerFailure !== undefined) throw workerFailure;
    if (worker !== undefined) return worker;

    // Keep the parent's loader arguments and environment, including strict PnP.
    const instance = new NodeWorker(workerFileName());
    worker = instance;
    instance.on("message", finish);
    instance.on("error", (error) => failWorker(instance, error));
    instance.on("exit", (code) =>
      failWorker(
        instance,
        new Error(`Package graph worker exited unexpectedly with code ${code}`)
      )
    );

    instance.postMessage({
      type: "reset",
      generation
    } satisfies PackageGraphWorkerCommand);

    for (const [moduleId, graph] of graphs)
      instance.postMessage({
        type: "register",
        generation,
        moduleId,
        graph
      } satisfies PackageGraphWorkerCommand);

    instance.unref();

    return instance;
  };

  const send = (command: PackageGraphWorkerCommand): void => {
    const instance = ensureWorker();

    try {
      instance.postMessage(command);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failWorker(instance, failure);

      throw failure;
    }
  };

  return {
    beginGeneration() {
      if (closed) throw closedError();

      generation++;
      revision++;
      graphs.clear();
      sizes.clear();
      rejectPending(staleGenerationError());
      workerFailure = undefined;

      if (worker !== undefined) send({ type: "reset", generation });

      return generation;
    },

    register(record) {
      if (closed || record.generation !== generation) return false;

      revision++;

      sizes.set(
        record.moduleId,
        Buffer.byteLength(JSON.stringify(record.graph))
      );

      if (mode !== "worker" || options.schedule)
        graphs.set(record.moduleId, structuredClone(record.graph));
      if (worker || (mode === "worker" && !options.schedule))
        send({ type: "register", ...record });

      return true;
    },

    remove(record) {
      if (closed || record.generation !== generation) return false;

      revision++;

      sizes.delete(record.moduleId);
      graphs.delete(record.moduleId);

      if (
        worker !== undefined ||
        (mode === "worker" && workerFailure !== undefined)
      )
        send({ type: "remove", ...record });

      return true;
    },

    analyze(request) {
      if (closed) return Promise.reject(closedError());
      if (request.generation !== generation) {
        return Promise.reject(staleGenerationError());
      }

      const bytes = [...new Set(request.moduleIds)].reduce(
        (sum, id) => sum + (sizes.get(id) ?? 0),
        0
      );

      const useWorker =
        mode === "worker"
          ? bytes > 0 || worker !== undefined || workerFailure !== undefined
          : mode === "auto" && bytes > 512 * 1024;

      const id = ++requestId;
      const selectedRevision = revision;
      const snapshot = structuredClone(request);
      const selectedGraphs = new Map<string, DefineRulesPackageGraph>();

      for (const moduleId of snapshot.moduleIds) {
        const graph = graphs.get(moduleId);

        if (graph !== undefined) selectedGraphs.set(moduleId, graph);
      }

      const execute = (
        requestedWorker: boolean
      ): Promise<PackageGraphAnalysisResult> =>
        new Promise((resolve, reject) => {
          if (closed) return reject(closedError());
          if (snapshot.generation !== generation)
            return reject(staleGenerationError());

          // Preserve the request snapshot if registrations changed while waiting
          // for the shared CPU budget, without retransmitting unchanged graphs.
          const useWorker = requestedWorker && selectedRevision === revision;
          options.onAnalysis?.(useWorker ? "worker" : "inline", bytes);
          pending.set(id, { generation, resolve, reject });

          // With no registered graphs there is no worker queue to wait for.
          if (useWorker) {
            try {
              const instance = ensureWorker();
              instance.ref();
              send({ ...snapshot, type: "analyze", requestId: id });
            } catch (error) {
              pending.delete(id);
              reject(error);
            }

            return;
          }

          // Match worker request snapshots and cancellation at message boundaries.
          queueMicrotask(() => {
            const current = pending.get(id);
            if (current === undefined) return;

            try {
              finish({
                type: "result",
                generation: snapshot.generation,
                requestId: id,
                result: analyzeRegisteredPackageGraphs(selectedGraphs, snapshot)
              });
            } catch (error) {
              pending.delete(id);
              current.reject(
                error instanceof Error ? error : new Error(String(error))
              );
            }
          });
        });

      return useWorker && options.schedule
        ? options.schedule(
            bytes,
            () => execute(true),
            () => execute(false)
          )
        : execute(useWorker);
    },

    close() {
      if (closing !== undefined) return closing;

      closed = true;
      graphs.clear();
      sizes.clear();
      rejectPending(closedError());

      const instance = worker;
      worker = undefined;
      closing =
        instance === undefined
          ? Promise.resolve()
          : instance.terminate().then(() => undefined);

      return closing;
    }
  };
}
