export interface MinchoExecutionOptions {
  /** Defaults to auto: graph workers only until compiler workers pass timing gates.
   * A positive number enables compiler workers; zero keeps all CPU work inline. */
  workers?: "auto" | number;

  /** Optional cap on concurrent leaf filesystem operations. */
  ioConcurrency?: number;

  /** Defaults to auto. Fresh disables VM context and evaluation result reuse. */
  evaluation?: "auto" | "fresh";
}

/** Omitted or true uses memory and filesystem caching. False disables caches.
 * Use { type: "memory" } to retain only in-process results. */
export type MinchoCacheOptions =
  | boolean
  | {
      type: "memory" | "filesystem";
      /** Optional directory for filesystem entries. */
      directory?: string;
      /** Maximum total filesystem cache bytes; defaults to 256 MiB. */
      maxBytes?: number;

      /** Reuse proved serialized evaluations when evaluation is auto. Defaults to true. */
      evaluationResults?: boolean;
    };
