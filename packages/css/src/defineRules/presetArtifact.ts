import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  parsePresetOriginId
} from "./presetCanonical.js";
import {
  readArray,
  readAtomId,
  readContentHash,
  readNodeId,
  readNullableString,
  readOrigin,
  readRecord,
  readString,
  throwInvalid
} from "./presetArtifactReaders.js";
import type {
  DefineRulesPresetArtifactV5,
  DefineRulesPresetAtomV5,
  DefineRulesPresetNodeV5,
  PresetNodeId
} from "./types.js";
import type { NormalizedCondition } from "./conditions.js";
import { assertDefineRulesPresetVersionV5 } from "./presetArtifactVersion.js";

type PresetArtifactInput = {
  readonly rootNodeId: PresetNodeId;
  readonly nodes: readonly DefineRulesPresetNodeV5[];
};

type ParsedNodeClaim = {
  readonly claimedNodeId: PresetNodeId;
  readonly path: string;
  readonly node: DefineRulesPresetNodeV5;
};

export function createDefineRulesPresetArtifactV5(
  input: PresetArtifactInput
): DefineRulesPresetArtifactV5 {
  const nodes = Object.freeze(
    input.nodes.map((node) =>
      createDefineRulesPresetNodeV5({
        origin: parsePresetOriginId(node.origin),
        parents: node.parents,
        atoms: node.atoms
      })
    )
  );
  assertArtifactReferences(input.rootNodeId, nodes);

  return Object.freeze({
    schema: "mincho.defineRulesPreset",
    version: 5,
    rootNodeId: input.rootNodeId,
    nodes
  });
}

export function parseDefineRulesPresetArtifactV5(
  value: unknown
): DefineRulesPresetArtifactV5 {
  assertDefineRulesPresetVersionV5(value);

  const artifact = readRecord(value, "$", [
    "schema",
    "version",
    "rootNodeId",
    "nodes"
  ]);

  if (artifact["schema"] !== "mincho.defineRulesPreset") {
    throwInvalid("$.schema", "expected defineRules preset schema");
  }
  if (artifact["version"] !== 5) {
    throwInvalid("$.version", "expected defineRules preset version 5");
  }

  const rootNodeId = readNodeId(artifact["rootNodeId"], "$.rootNodeId");
  const rawNodes = readArray(artifact["nodes"], "$.nodes");
  const claims = rawNodes.map((node, index) =>
    parseNode(node, `$.nodes[${index}]`)
  );
  assertClaimedReferences(rootNodeId, claims);
  assertNoClaimedCycles(rootNodeId, claims);
  const nodes = Object.freeze(claims.map((claim) => claim.node));
  assertClaimedHashes(claims);
  return Object.freeze({
    schema: "mincho.defineRulesPreset",
    version: 5,
    rootNodeId,
    nodes
  });
}

function parseNode(value: unknown, path: string): ParsedNodeClaim {
  const node = readRecord(value, path, [
    "nodeId",
    "origin",
    "contentHash",
    "parents",
    "atoms"
  ]);
  const claimedNodeId = readNodeId(node["nodeId"], `${path}.nodeId`);
  const claimedContentHash = readContentHash(
    node["contentHash"],
    `${path}.contentHash`
  );
  const origin = readOrigin(node["origin"], `${path}.origin`);
  const parents = readArray(node["parents"], `${path}.parents`).map(
    (parent, index) => readNodeId(parent, `${path}.parents[${index}]`)
  );
  const atoms = readArray(node["atoms"], `${path}.atoms`).map((atom, index) =>
    parseAtom(atom, `${path}.atoms[${index}]`)
  );
  const parsed = createDefineRulesPresetNodeV5({ origin, parents, atoms });

  return Object.freeze({
    claimedNodeId,
    path,
    node: Object.freeze({
      ...parsed,
      nodeId: claimedNodeId,
      contentHash: claimedContentHash,
      parents: parsed.parents
    })
  });
}

function parseAtom(value: unknown, path: string): DefineRulesPresetAtomV5 {
  const atom = readRecord(value, path, [
    "atomId",
    "cacheKey",
    "className",
    "condition",
    "property"
  ]);
  const claimedAtomId = readAtomId(atom["atomId"], `${path}.atomId`);
  const cacheKey = readString(atom["cacheKey"], `${path}.cacheKey`);
  const className = readString(atom["className"], `${path}.className`);
  const property = readString(atom["property"], `${path}.property`);
  const condition = readCondition(atom["condition"], `${path}.condition`);
  const parsed = createDefineRulesPresetAtomV5({
    cacheKey,
    className,
    condition,
    property
  });

  if (claimedAtomId !== parsed.atomId) {
    throwInvalid(
      `${path}.atomId`,
      "claimed atom ID does not match canonical content"
    );
  }

  return parsed;
}

function readCondition(
  value: unknown,
  path: string
): Readonly<NormalizedCondition> {
  const condition = readRecord(value, path, [
    "layer",
    "supports",
    "media",
    "container",
    "selector"
  ]);
  return Object.freeze({
    layer: readNullableString(condition["layer"], `${path}.layer`),
    supports: readNullableString(condition["supports"], `${path}.supports`),
    media: readNullableString(condition["media"], `${path}.media`),
    container: readNullableString(condition["container"], `${path}.container`),
    selector: readString(condition["selector"], `${path}.selector`)
  });
}

function assertArtifactReferences(
  rootNodeId: PresetNodeId,
  nodes: readonly DefineRulesPresetNodeV5[]
): void {
  const nodeIds = new Set<PresetNodeId>();

  for (const node of nodes) {
    if (nodeIds.has(node.nodeId))
      throw new TypeError("Duplicate defineRules preset node ID");
    nodeIds.add(node.nodeId);
  }

  if (!nodeIds.has(rootNodeId))
    throw new TypeError("Missing defineRules preset root node");
  for (const node of nodes) {
    for (const parent of node.parents) {
      if (!nodeIds.has(parent))
        throw new TypeError("Missing defineRules preset parent node");
    }
  }
}

function assertClaimedReferences(
  rootNodeId: PresetNodeId,
  claims: readonly ParsedNodeClaim[]
): void {
  const nodeIds = new Set<PresetNodeId>();

  for (const claim of claims) {
    if (nodeIds.has(claim.claimedNodeId))
      throwInvalid("$", "Duplicate defineRules preset node ID");
    nodeIds.add(claim.claimedNodeId);
  }

  if (!nodeIds.has(rootNodeId))
    throwInvalid("$", "Missing defineRules preset root node");
  for (const claim of claims) {
    for (const parent of claim.node.parents) {
      if (!nodeIds.has(parent))
        throwInvalid(claim.path, "Missing defineRules preset parent node");
    }
  }
}

function assertNoClaimedCycles(
  rootNodeId: PresetNodeId,
  claims: readonly ParsedNodeClaim[]
): void {
  const nodes = new Map(claims.map((claim) => [claim.claimedNodeId, claim]));
  const colors = new Map<PresetNodeId, 0 | 1 | 2>();

  function visit(nodeId: PresetNodeId, path: string): void {
    const color = colors.get(nodeId);
    if (color === 1) throwInvalid(path, "cycle detected");
    if (color === 2) return;
    const claim = nodes.get(nodeId);
    if (claim === undefined)
      throwInvalid(path, "Missing defineRules preset parent node");
    colors.set(nodeId, 1);
    for (const [parentIndex, parentId] of claim.node.parents.entries()) {
      const parent = nodes.get(parentId);
      const parentPath = `${path}.parents[${parentIndex}]${
        parent === undefined ? "" : ` -> ${parent.node.origin}`
      }`;
      visit(parentId, parentPath);
    }
    colors.set(nodeId, 2);
  }

  const root = nodes.get(rootNodeId);
  if (root !== undefined) visit(rootNodeId, root.node.origin);
}

function assertClaimedHashes(claims: readonly ParsedNodeClaim[]): void {
  for (const claim of claims) {
    const parsed = createDefineRulesPresetNodeV5({
      origin: parsePresetOriginId(claim.node.origin),
      parents: claim.node.parents,
      atoms: claim.node.atoms
    });
    if (
      claim.node.contentHash !== parsed.contentHash ||
      claim.claimedNodeId !== parsed.nodeId
    ) {
      throwInvalid(
        claim.path,
        "claimed node hashes do not match canonical content"
      );
    }
  }
}
