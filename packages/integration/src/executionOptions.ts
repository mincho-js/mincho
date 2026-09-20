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
