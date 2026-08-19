import { getFileScope, hasFileScope } from "@vanilla-extract/css/fileScope";
import {
  createDefineRulesPresetArtifactV5,
  parseDefineRulesPresetArtifactV5
} from "./presetArtifact.js";
import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";
import type { EngineMetadata } from "./metadata.js";
import type {
  DefineRulesPresetArtifactV5,
  DefineRulesPresetAtomV5,
  DefineRulesPresetInput,
  PresetOriginId
} from "./types.js";
import type { createCanonicalStyleCache } from "./utils.js";

const nextUnregisteredOriginIndexByFileScope = new Map<string, number>();

type RuntimePresetState = {
  readonly addOwnAtom: (atom: Omit<DefineRulesPresetAtomV5, "atomId">) => void;
  readonly bindOrigin: (origin: PresetOriginId) => void;
  readonly getSnapshot: () => DefineRulesPresetArtifactV5;
};

export function createRuntimePresetState(
  presetInput: DefineRulesPresetInput | undefined,
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  metadata: EngineMetadata
): RuntimePresetState {
  const parents = collectPresetArtifacts(presetInput);
  const graph = resolveDefineRulesPresetGraphV5(parents);
  const ownAtoms: DefineRulesPresetAtomV5[] = [];
  const ownAtomIds = new Set<string>();
  let origin: PresetOriginId | undefined;
  let snapshot: DefineRulesPresetArtifactV5 | undefined;

  for (const atom of graph.atomById.values()) {
    styleCache.hydrateFragment(atom.cacheKey, atom.className);
  }
  for (const [className, atomId] of graph.atomIdByClassName) {
    const atom = graph.atomById.get(atomId);

    if (atom !== undefined) {
      registerAtom(metadata, atom, className);
    }
  }

  const parentNodeIds = parents.map((artifact) => artifact.rootNodeId);

  return {
    addOwnAtom(atom): void {
      const created = createDefineRulesPresetAtomV5(atom);

      if (ownAtomIds.has(created.atomId)) {
        return;
      }

      ownAtomIds.add(created.atomId);
      ownAtoms.push(created);
      snapshot = undefined;
      registerAtom(metadata, created, created.className);
    },
    bindOrigin(nextOrigin): void {
      origin = nextOrigin;
    },
    getSnapshot(): DefineRulesPresetArtifactV5 {
      if (snapshot !== undefined) {
        return snapshot;
      }

      const ownNode = createDefineRulesPresetNodeV5({
        origin: (origin ??= createUnregisteredRuntimeOrigin()),
        parents: parentNodeIds,
        atoms: ownAtoms
      });

      snapshot = createDefineRulesPresetArtifactV5({
        rootNodeId: ownNode.nodeId,
        nodes: [...collectParentNodes(parents), ownNode]
      });
      return snapshot;
    }
  };
}

function collectParentNodes(
  artifacts: readonly DefineRulesPresetArtifactV5[]
): DefineRulesPresetArtifactV5["nodes"] {
  const nodes = new Map<string, DefineRulesPresetArtifactV5["nodes"][number]>();

  for (const artifact of artifacts) {
    for (const node of artifact.nodes) {
      nodes.set(node.nodeId, node);
    }
  }

  return [...nodes.values()];
}

function collectPresetArtifacts(
  presetInput: DefineRulesPresetInput | undefined
): DefineRulesPresetArtifactV5[] {
  if (presetInput === undefined) {
    return [];
  }

  if (!Array.isArray(presetInput)) {
    return [parseDefineRulesPresetArtifactV5(presetInput)];
  }

  return presetInput.flatMap(collectPresetArtifacts);
}

function registerAtom(
  metadata: EngineMetadata,
  atom: DefineRulesPresetAtomV5,
  className: string
): void {
  const conditionId = metadata.internCondition(atom.condition);
  const propertyId = metadata.internProperty(atom.property);
  const writeKeyId = metadata.internWriteKey(conditionId, propertyId);

  metadata.registerAtomicClass(className, writeKeyId);
}

function createUnregisteredRuntimeOrigin() {
  const fileScope = hasFileScope() ? getFileScope() : undefined;
  const packageName = fileScope?.packageName ?? "<runtime>";
  const producerPath =
    fileScope?.filePath.replace(/\\/g, "/") ?? "runtime.css.ts";
  const key = `${packageName}:${producerPath}`;
  const registrationIndex =
    nextUnregisteredOriginIndexByFileScope.get(key) ?? 0;

  nextUnregisteredOriginIndexByFileScope.set(key, registrationIndex + 1);
  return createPresetOriginId({ packageName, producerPath, registrationIndex });
}
