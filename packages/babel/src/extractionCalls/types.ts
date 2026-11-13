import type { NodePath, TransformOptions, types as t } from "@babel/core";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";

/** Additional build-time calls, indexed by import source or root-relative file. */
export type ExtractCalls = Readonly<Record<string, readonly string[]>>;

export interface PreparedExtractCalls {
  readonly imports: ExtractCalls;
  readonly localBindings: readonly string[];
  readonly requires?: ExtractCalls;
  /** Positive module identity evidence; unresolved sources are omitted. */
  readonly resolvedSources?: {
    readonly import: Readonly<Record<string, string>>;
    readonly require: Readonly<Record<string, string>>;
  };
  readonly fingerprint: string;
  readonly protectedFunctions: readonly { start: number; end: number }[];
  readonly dependencies: readonly string[];
}

export interface ExtractCallsAnalysisOptions {
  readonly extractCalls: ExtractCalls;
  readonly root: string;
  readonly filename: string;
  readonly source: string;
  readonly jsx?: boolean;
  readonly program?: NodePath<t.Program>;
  readonly parserCache?: SourceAstCache;
  readonly parserPlugins?: NonNullable<
    TransformOptions["parserOpts"]
  >["plugins"];
}

export type ExtractCallsRequest =
  import("../moduleGraph.js").ModuleGraphRequest;

export type ExtractCallsAnalysis = Generator<
  ExtractCallsRequest,
  PreparedExtractCalls,
  string | null
>;

export class ExtractCallsError extends Error {
  readonly dependencies: readonly string[];

  constructor(
    message: string,
    dependencies: Iterable<string>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExtractCallsError";
    this.dependencies = [...dependencies].sort();
  }
}
