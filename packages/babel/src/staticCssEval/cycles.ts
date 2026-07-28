import { STATIC_CSS_EVAL_CYCLE_KEY_FIELDS } from "./types.js";
import {
  createStaticCssEvalDiagnostic,
  type StaticCssEvalDiagnosticContext
} from "./diagnostics.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalSourceLocation
} from "./types.js";

export interface StaticCssEvalCycleKeyInput {
  resolvedId: string;
  exportName: StaticCssEvalExportName;
  memberPath?: readonly string[];
}

export interface StaticCssEvalCycleFrame extends StaticCssEvalCycleKeyInput {
  importPath?: string;
  location?: StaticCssEvalSourceLocation;
}

export type StaticCssEvalCycleCheckResult =
  | {
      ok: true;
      stack: StaticCssEvalCycleFrame[];
    }
  | {
      ok: false;
      diagnostic: StaticCssEvalDiagnostic;
      dependencies: string[];
      cycle: StaticCssEvalCycleFrame[];
    };

export function createStaticCssEvalCycleKey(
  input: StaticCssEvalCycleKeyInput
): string {
  const cycleIdentity = {
    resolvedId: input.resolvedId,
    exportName: input.exportName,
    memberPath: [...(input.memberPath ?? [])]
  } satisfies Record<
    (typeof STATIC_CSS_EVAL_CYCLE_KEY_FIELDS)[number],
    StaticCssEvalExportName | string | string[]
  >;

  return JSON.stringify(
    STATIC_CSS_EVAL_CYCLE_KEY_FIELDS.map((field) => cycleIdentity[field])
  );
}

export function enterStaticCssEvalCycleFrame(
  options: StaticCssEvalDiagnosticContext & {
    stack: readonly StaticCssEvalCycleFrame[];
    nextFrame: StaticCssEvalCycleFrame;
  }
): StaticCssEvalCycleCheckResult {
  const cycleStartIndex = findStaticCssEvalCycleStartIndex(
    options.stack,
    options.nextFrame
  );

  if (cycleStartIndex === -1) {
    return {
      ok: true,
      stack: [...options.stack, cloneCycleFrame(options.nextFrame)]
    };
  }

  const cycle = [
    ...options.stack.slice(cycleStartIndex).map(cloneCycleFrame),
    cloneCycleFrame(options.nextFrame)
  ];
  const importChain = cycle.map(formatStaticCssEvalCycleFrame);
  const dependency =
    options.nextFrame.location ??
    options.dependency ??
    ({
      file: options.nextFrame.resolvedId
    } satisfies StaticCssEvalSourceLocation);
  const diagnostic = createStaticCssEvalDiagnostic({
    code: "cycle-detected",
    reason: "runtime-dynamic-value",
    detail: `cyclic static css reference detected: ${importChain.join(" -> ")}`,
    owner: options.owner,
    dependency,
    importPath: options.nextFrame.importPath ?? options.importPath,
    exportName: options.nextFrame.exportName,
    memberPath: options.nextFrame.memberPath,
    importChain
  });

  return {
    ok: false,
    diagnostic,
    dependencies: getStaticCssEvalCycleDependencies(cycle, options.owner.file),
    cycle
  };
}

export function formatStaticCssEvalCycleFrame(
  frame: StaticCssEvalCycleKeyInput
): string {
  const exportName = frame.exportName === null ? "<local>" : frame.exportName;
  const memberPath = frame.memberPath?.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${frame.resolvedId}#${exportName}${memberPath}`;
}

function findStaticCssEvalCycleStartIndex(
  stack: readonly StaticCssEvalCycleFrame[],
  nextFrame: StaticCssEvalCycleFrame
): number {
  const nextKey = createStaticCssEvalCycleKey(nextFrame);

  return stack.findIndex(
    (frame) => createStaticCssEvalCycleKey(frame) === nextKey
  );
}

function cloneCycleFrame(
  frame: StaticCssEvalCycleFrame
): StaticCssEvalCycleFrame {
  return {
    resolvedId: frame.resolvedId,
    exportName: frame.exportName,
    memberPath: [...(frame.memberPath ?? [])],
    ...(frame.importPath !== undefined ? { importPath: frame.importPath } : {}),
    ...(frame.location ? { location: { ...frame.location } } : {})
  };
}

function getStaticCssEvalCycleDependencies(
  cycle: readonly StaticCssEvalCycleFrame[],
  ownerFile: string
): string[] {
  const dependencies = new Set<string>();

  for (const frame of cycle) {
    if (frame.resolvedId !== ownerFile) {
      dependencies.add(frame.resolvedId);
    }
  }

  return [...dependencies];
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
const vitest = import.meta.vitest;

if (vitest) {
  const { describe, expect, it } = vitest;

  const owner = { file: "/project/src/App.tsx", start: 10, end: 30 };

  describe("static css eval cycles", () => {
    it("keys cycles by resolved file, export name, and member path only", () => {
      expect(STATIC_CSS_EVAL_CYCLE_KEY_FIELDS).toEqual([
        "resolvedId",
        "exportName",
        "memberPath"
      ]);
      expect(
        createStaticCssEvalCycleKey({
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        })
      ).toBe(
        createStaticCssEvalCycleKey({
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        })
      );
      expect(
        createStaticCssEvalCycleKey({
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        })
      ).not.toBe(
        createStaticCssEvalCycleKey({
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["card"]
        })
      );
    });

    it("returns a targeted diagnostic with import-chain details for cycles", () => {
      const stack: StaticCssEvalCycleFrame[] = [
        {
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"],
          importPath: "./a",
          location: { file: "/project/src/a.ts" }
        },
        {
          resolvedId: "/project/src/b.ts",
          exportName: "styles",
          memberPath: ["button"],
          importPath: "./b",
          location: { file: "/project/src/b.ts" }
        }
      ];
      const result = enterStaticCssEvalCycleFrame({
        owner,
        stack,
        nextFrame: {
          resolvedId: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"],
          importPath: "./a",
          location: { file: "/project/src/a.ts" }
        }
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          code: "cycle-detected",
          reason: "runtime-dynamic-value",
          owner,
          dependency: { file: "/project/src/a.ts" },
          importPath: "./a",
          exportName: "styles",
          memberPath: ["button"],
          importChain: [
            "/project/src/a.ts#styles.button",
            "/project/src/b.ts#styles.button",
            "/project/src/a.ts#styles.button"
          ]
        });
        expect(result.diagnostic.message).toContain("cyclic");
        expect(result.dependencies).toEqual([
          "/project/src/a.ts",
          "/project/src/b.ts"
        ]);
      }
    });

    it("pushes non-cyclic frames and keeps different exports independent", () => {
      const result = enterStaticCssEvalCycleFrame({
        owner,
        stack: [
          {
            resolvedId: "/project/src/a.ts",
            exportName: "styles",
            memberPath: ["button"]
          }
        ],
        nextFrame: {
          resolvedId: "/project/src/a.ts",
          exportName: "tokens",
          memberPath: ["button"]
        }
      });

      expect(result).toEqual({
        ok: true,
        stack: [
          {
            resolvedId: "/project/src/a.ts",
            exportName: "styles",
            memberPath: ["button"]
          },
          {
            resolvedId: "/project/src/a.ts",
            exportName: "tokens",
            memberPath: ["button"]
          }
        ]
      });
    });
  });
}
