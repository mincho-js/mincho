export interface MinchoExecutionOptions {
  /** Defaults to auto: graph workers only until compiler workers pass timing gates.
   * A positive number enables compiler workers; zero keeps all CPU work inline. */
  workers?: "auto" | number;

  /** Optional cap on concurrent leaf filesystem operations. */
  ioConcurrency?: number;
}

/** Omitted or true uses memory only. Filesystem caching is opt-in. */
export type MinchoCacheOptions =
  | boolean
  | {
      type: "memory" | "filesystem";
      /** Optional directory for filesystem entries. */
      directory?: string;
      /** Maximum total filesystem cache bytes; defaults to 256 MiB. */
      maxBytes?: number;
    };
