import type { StaticCssEvalExportName } from "../types.js";

export function formatExportName(exportName: StaticCssEvalExportName): string {
  return exportName === null ? "<local>" : exportName;
}
