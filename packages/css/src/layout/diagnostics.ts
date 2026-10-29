import type { LayoutDiagnostic, LayoutDiagnosticCode } from "./types.js";

export class LayoutError extends Error {
  readonly diagnostic: LayoutDiagnostic;

  constructor(diagnostic: LayoutDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "LayoutError";
    this.diagnostic = diagnostic;
  }
}

export function fail(
  code: LayoutDiagnosticCode,
  message: string,
  location: Pick<LayoutDiagnostic, "itemId" | "boundaryId"> = {}
): never {
  throw new LayoutError({ code, message, ...location });
}

export function number(
  value: unknown,
  label: string,
  positive = false
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    fail(
      "E_INVALID_NUMBER",
      `${label} must be a finite ${positive ? "positive" : "nonnegative"} number.`
    );
  }
  return value;
}

export function choice<T extends string>(
  value: T,
  choices: readonly T[],
  label: string
): T {
  if (!choices.includes(value)) {
    fail("E_LAYOUT_CAPABILITY", `Invalid ${label}: ${String(value)}.`);
  }
  return value;
}
