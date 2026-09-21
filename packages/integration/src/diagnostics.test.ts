import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CompilationDiagnostics,
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";

describe("compilation diagnostics", () => {
  it("publishes the latest generation to each output and preserves identical files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-diagnostics-writes-"));

    try {
      const diagnostics = new CompilationDiagnostics({
        json: "report.json",
        trace: "trace.json"
      });

      diagnostics.begin();
      diagnostics.record("old.ts", "old");

      const old = diagnostics.flush(root);
      diagnostics.begin();
      diagnostics.record("new.ts", "new");
      await Promise.all([old, diagnostics.flush(root)]);

      const json = join(root, "report.json");
      const trace = join(root, "trace.json");
      const report = JSON.parse(await readFile(json, "utf8"));

      expect(report.builds[0].generation).toBe(2);
      expect(
        report.builds[0].events.map((event: { phase: string }) => event.phase)
      ).toEqual(["new"]);
      expect(
        JSON.parse(await readFile(trace, "utf8")).traceEvents[0].name
      ).toBe("new");

      const jsonBefore = await stat(json);
      const traceBefore = await stat(trace);
      await diagnostics.flush(root);

      expect((await stat(json)).ino).toBe(jsonBefore.ino);
      expect((await stat(trace)).ino).toBe(traceBefore.ino);
      expect((await readdir(root)).sort()).toEqual([
        "report.json",
        "trace.json"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not collect disabled instrumentation and preserves results", async () => {
    const diagnostics = new CompilationDiagnostics();
    const now = vi.spyOn(performance, "now");

    try {
      diagnostics.begin();
      const result = Promise.resolve(42);

      expect(diagnostics.run("file", "transform", () => result)).toBe(result);
      expect(await measureCompilationPhase("parse", () => result)).toBe(42);
      diagnostics.record("file", "cache-hit");
      recordCompilationDiagnostic("cache-hit");

      expect(now).not.toHaveBeenCalled();
      expect(diagnostics.snapshot().builds).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("isolates overlapping environments and drops obsolete completions", async () => {
    const diagnostics = new CompilationDiagnostics(
      { json: "report.json" },
      "client"
    );

    const server = diagnostics.fork("ssr");
    let finish!: () => void;
    const old = diagnostics.run(
      "old.ts",
      "transform",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    diagnostics.begin();
    await Promise.all([
      diagnostics.run("client.ts", "transform", async () => {
        await measureCompilationPhase("parse", async () => undefined);
        recordCompilationDiagnostic("cache-miss", { reason: "source-changed" });
      }),
      server.run("server.ts", "transform", async () => undefined)
    ]);
    finish();
    await old;

    const report = diagnostics.snapshot();

    expect(report.builds.map((build) => build.environment)).toEqual([
      "client",
      "ssr"
    ]);
    expect(report.builds[0]?.generation).toBe(2);
    expect(report.builds[0]?.events.map((event) => event.phase)).toEqual([
      "parse",
      "cache-miss",
      "transform"
    ]);
    expect(
      report.builds
        .flatMap((build) => build.events)
        .some((event) => event.file === "old.ts")
    ).toBe(false);
  });

  it("writes machine reports and trace events after failures without masking errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-diagnostics-"));

    try {
      const diagnostics = new CompilationDiagnostics({
        json: "report.json",
        trace: "trace.json"
      });

      const error = new Error("failed compilation");

      await expect(
        diagnostics.run("App.tsx", "babel", async () => {
          throw error;
        })
      ).rejects.toBe(error);

      await diagnostics.flush(root);

      const report = JSON.parse(
        await readFile(join(root, "report.json"), "utf8")
      );

      const trace = JSON.parse(
        await readFile(join(root, "trace.json"), "utf8")
      );

      expect(report.version).toBe(1);
      expect(report.builds[0].events[0]).toMatchObject({
        file: "App.tsx",
        phase: "babel",
        status: "error"
      });
      expect(trace.traceEvents[0]).toMatchObject({
        name: "babel",
        ph: "X",
        args: { status: "error" }
      });
      expect(trace.traceEvents[0].dur).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
