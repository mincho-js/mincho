import type { ClosedOwnAllocationShape } from "./closedAllocation.js";
import type { AuthoringCallContract } from "./authoringContract.js";
import type { NodePath, TransformOptions, types as t } from "@babel/core";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";

/** Additional build-time calls, indexed by import source or root-relative file. */
export type ExtractCalls = Readonly<Record<string, readonly string[]>>;

/** Normal-call result only; never purity, invocation movement, or construct authority. */
export type SourceInvocationResult =
  | { readonly kind: "primitive" }
  | { readonly kind: "argument"; readonly index: number };

export interface PreparedExtractCalls {
  /** Final loaded-graph snapshot, never a per-export intrinsic approval. */
  readonly arrayMapIntrinsics?: {
    readonly intact: boolean;
    /** Operation-specific observations; absent flags inherit legacy intact. */
    readonly iterationIntact?: boolean;
    readonly prototypeAbsenceIntact?: boolean;
    /** Sorted precise keys; null means unbounded, absent uses the legacy boolean. */
    readonly prototypeMutationKeys?: readonly string[] | null;
    readonly revision: number;
    readonly fingerprint: string;
  };
  readonly mathIntrinsics?: {
    readonly intact: boolean;
    readonly bindIntact: boolean;
    readonly revision: number;
    readonly fingerprint: string;
  };
  readonly imports: ExtractCalls;
  readonly localBindings: readonly string[];
  readonly requires?: ExtractCalls;
  /** Positive module identity evidence; unresolved sources are omitted. */
  readonly resolvedSources?: {
    readonly import: Readonly<Record<string, string>>;
    readonly require: Readonly<Record<string, string>>;
  };
  /** Canonical static object origins keyed by module ID and export path. */
  readonly exportOrigins?: Readonly<
    Record<
      string,
      {
        readonly exports: Readonly<Record<string, string>>;
        readonly esModule: boolean;
        readonly unknownExports?: readonly string[];
        /** Known allocation, but properties/captures may reach another owner. */
        readonly unknownContents?: readonly string[];
        /** Invocation effects only; this does not certify the result or shape. */
        readonly inertInvocations?: Readonly<
          Record<string, "call" | "construct">
        >;
        /** Verified artifact direct calls return strings on normal completion.
         * Not an effect-free certificate: preserve input getters/coercions/throws. */
        readonly recipeInvocations?: Readonly<Record<string, "class-string">>;
        readonly authoringCalls?: Readonly<
          Record<string, AuthoringCallContract>
        >;
        /** Source-proved fresh own slots, not inherited properties, effects, or order. */
        readonly closedOwnAllocations?: Readonly<
          Record<string, ClosedOwnAllocationShape>
        >;
        readonly sourceInvocationResults?: Readonly<
          Record<string, SourceInvocationResult>
        >;
        /** Exact primitive-valued exports. Not a read/effect/order certificate. */
        readonly primitiveExports?: readonly string[];
        /** Ordinary own data slots proved on an immutable producer shape. */
        readonly ownDataPaths?: readonly string[];
        /** Reads of host-emitted ESM bindings do not invoke user accessors. */
        readonly readablePaths?: readonly string[];
        /** Complete own-data shapes, needed for copies that enumerate slots. */
        readonly closedDataPaths?: readonly string[];
      }
    >
  >;
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
  import("../moduleGraph.js").ModuleGraphResponse
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
