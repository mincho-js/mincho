import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { CoalescedAtomicWriter } from "./coalescedWriter.js";

export interface MinchoDiagnosticsOptions {
  console?: boolean;
  json?: string;
  trace?: string;
}

export interface CompilationEvent {
  readonly file: string;
  readonly phase: string;
  readonly start: number;
  readonly duration: number;
  readonly status: "ok" | "error" | "info";
  readonly detail?: unknown;
}

interface CompilationReport {
  environment: string;
  generation: number;
  events: CompilationEvent[];
}

interface DiagnosticOutput {
  reports: Map<string, CompilationReport>;
  writer: CoalescedAtomicWriter;
}

const active = new AsyncLocalStorage<{
  diagnostics: CompilationDiagnostics;
  report: CompilationReport;
  file: string;
}>();

/** Build-only instrumentation. Disabled collectors never read the clock. */
export class CompilationDiagnostics {
  private generation = 0;
  private report?: CompilationReport;
  readonly enabled: boolean;

  constructor(
    private readonly options: MinchoDiagnosticsOptions = {},
    private readonly environment = "default",
    private readonly output: DiagnosticOutput = {
      reports: new Map(),
      writer: new CoalescedAtomicWriter()
    }
  ) {
    this.enabled = Boolean(options.console || options.json || options.trace);
  }

  fork(environment: string): CompilationDiagnostics {
    return new CompilationDiagnostics(this.options, environment, this.output);
  }

  begin(): void {
    if (!this.enabled) return;

    this.report = {
      environment: this.environment,
      generation: ++this.generation,
      events: []
    };
    this.output.reports.set(this.environment, this.report);
  }

  record(file: string, phase: string, detail?: unknown): void {
    if (!this.enabled) return;
    if (!this.report) this.begin();

    this.report!.events.push({
      file,
      phase,
      start: performance.now(),
      duration: 0,
      status: "info",
      ...(detail === undefined ? {} : { detail })
    });
  }

  run<T>(file: string, phase: string, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled) return operation();
    if (!this.report) this.begin();

    return active.run({ diagnostics: this, report: this.report!, file }, () =>
      measureCompilationPhase(phase, operation)
    );
  }

  append(report: CompilationReport, event: CompilationEvent): void {
    if (report === this.report) report.events.push(event);
  }

  snapshot() {
    return {
      version: 1 as const,
      builds: structuredClone([...this.output.reports.values()])
    };
  }

  flush(root: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();

    const write = async () => {
      const report = this.snapshot();

      const isCurrent = () =>
        report.builds.every(
          (build) =>
            this.output.reports.get(build.environment)?.generation ===
            build.generation
        );

      if (this.options.console) {
        const phases = new Map<
          string,
          { count: number; milliseconds: number }
        >();

        for (const build of report.builds)
          for (const event of build.events) {
            const phase = phases.get(event.phase) ?? {
              count: 0,
              milliseconds: 0
            };

            phase.count++;
            phase.milliseconds += event.duration;
            phases.set(event.phase, phase);
          }

        console.info("[mincho] compilation", Object.fromEntries(phases));
      }

      const writes: Array<Promise<void>> = [];

      if (this.options.json)
        writes.push(this.write(root, this.options.json, report, isCurrent));
      if (this.options.trace)
        writes.push(
          this.write(
            root,
            this.options.trace,
            {
              traceEvents: report.builds.flatMap((build, thread) =>
                build.events.map((event) => ({
                  name: event.phase,
                  cat: "mincho",
                  ph: "X",
                  pid: process.pid,
                  tid: thread,
                  ts: event.start * 1000,
                  dur: event.duration * 1000,
                  args: {
                    file: event.file,
                    environment: build.environment,
                    generation: build.generation,
                    status: event.status,
                    detail: event.detail
                  }
                }))
              )
            },
            isCurrent
          )
        );

      await Promise.all(writes);
      await this.output.writer.flush();
    };

    return write();
  }

  private async write(
    root: string,
    file: string,
    value: unknown,
    isCurrent: () => boolean
  ): Promise<void> {
    await this.output.writer.write(
      resolve(root, file),
      () => `${JSON.stringify(value, null, 2)}\n`,
      {
        isCurrent,

        observe: (event) =>
          recordCompilationDiagnostic(`diagnostic-write-${event.kind}`, {
            path: event.path,
            bytes: event.bytes
          })
      }
    );
  }
}

export async function measureCompilationPhase<T>(
  phase: string,
  operation: () => Promise<T>
): Promise<T> {
  const context = active.getStore();
  if (!context) return operation();

  const start = performance.now();
  let status: CompilationEvent["status"] = "ok";

  try {
    return await operation();
  } catch (error) {
    status = "error";

    throw error;
  } finally {
    context.diagnostics.append(context.report, {
      file: context.file,
      phase,
      start,
      duration: performance.now() - start,
      status
    });
  }
}

export function recordCompilationDiagnostic(
  phase: string,
  detail?: unknown
): void {
  const context = active.getStore();
  if (!context) return;

  context.diagnostics.append(context.report, {
    file: context.file,
    phase,
    start: performance.now(),
    duration: 0,
    status: "info",
    ...(detail === undefined ? {} : { detail })
  });
}

/** Preserve the caller's report when native services reuse older async contexts. */
export function bindCompilationDiagnostics<A extends unknown[], T>(
  operation: (...args: A) => T
): (...args: A) => T {
  const context = active.getStore();

  return context
    ? (...args) => active.run(context, () => operation(...args))
    : operation;
}
