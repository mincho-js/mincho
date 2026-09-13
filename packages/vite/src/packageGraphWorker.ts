import { parentPort } from "node:worker_threads";
import type { DefineRulesPackageGraph } from "@mincho-js/integration/package-graph";
import {
  analyzeRegisteredPackageGraphs,
  serializePackageGraphError,
  type PackageGraphWorkerCommand,
  type PackageGraphWorkerResponse
} from "./packageGraphAnalysisCore.js";

if (parentPort === null) {
  throw new Error("The package graph worker requires a parent message port");
}

const port = parentPort;
const graphs = new Map<string, DefineRulesPackageGraph>();
let generation = 0;

port.on("message", (command: PackageGraphWorkerCommand) => {
  if (command.type === "reset") {
    generation = command.generation;
    graphs.clear();

    return;
  }

  if (command.type === "register" || command.type === "remove") {
    if (command.generation !== generation) return;

    if (command.type === "register")
      graphs.set(command.moduleId, command.graph);
    else graphs.delete(command.moduleId);

    return;
  }

  let response: PackageGraphWorkerResponse;

  try {
    if (command.generation !== generation) {
      throw new Error("Package graph analysis generation is no longer current");
    }

    response = {
      type: "result",
      requestId: command.requestId,
      generation,
      result: analyzeRegisteredPackageGraphs(graphs, command)
    };
  } catch (error) {
    response = {
      type: "error",
      requestId: command.requestId,
      generation: command.generation,
      error: serializePackageGraphError(error)
    };
  }

  port.postMessage(response);
});
