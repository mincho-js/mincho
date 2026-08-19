import {
  createDefineRulesPresetAtomV5,
  hashPresetCanonical
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
import type { NormalizedCondition } from "./conditions.js";
import type {
  DefineRulesPresetArtifactV5,
  DefineRulesPresetAtomV5,
  PresetAtomId,
  PresetOriginId
} from "./types.js";

export type DefineRulesPresetGraphV5 = {
  readonly atomById: ReadonlyMap<PresetAtomId, DefineRulesPresetAtomV5>;
  readonly atomIdByClassName: ReadonlyMap<string, PresetAtomId>;
  readonly producerOrigins: readonly PresetOriginId[];
  readonly styleOrigins: readonly string[];
};

type GraphNode = {
  readonly nodeId: string;
  readonly origin: PresetOriginId;
  readonly contentHash: string;
  readonly parents: readonly string[];
  readonly atoms: readonly DefineRulesPresetAtomV5[];
};

export function resolveDefineRulesPresetGraphV5(
  artifacts: readonly DefineRulesPresetArtifactV5[]
): DefineRulesPresetGraphV5 {
  const nodes = new Map<string, GraphNode>();
  const roots: string[] = [];
  for (const [artifactIndex, artifact] of artifacts.entries()) {
    const parsed = readArtifact(artifact, `artifacts[${artifactIndex}]`);
    roots.push(parsed.rootNodeId);
    for (const node of parsed.nodes) {
      const existing = nodes.get(node.nodeId);
      if (existing !== undefined && !sameNode(existing, node))
        throwInvalid(node.origin, "node ID maps to different content");
      nodes.set(node.nodeId, node);
    }
  }

  const colors = new Map<string, 0 | 1 | 2>();
  const atomById = new Map<PresetAtomId, DefineRulesPresetAtomV5>();
  const atomIdByClassName = new Map<string, PresetAtomId>();
  const classPaths = new Map<string, string>();
  const revisions = new Map<
    PresetOriginId,
    { readonly contentHash: string; readonly path: string }
  >();
  const producerOrigins: PresetOriginId[] = [];
  const styleOrigins: string[] = [];
  const styles = new Set<string>();

  function visit(nodeId: string, path: string): void {
    const color = colors.get(nodeId);
    if (color === 1) throwInvalid(path, "cycle detected");
    if (color === 2) return;
    const node = nodes.get(nodeId);
    if (node === undefined)
      throwInvalid(path, `dangling parent node ${nodeId}`);
    const revision = revisions.get(node.origin);
    if (revision !== undefined && revision.contentHash !== node.contentHash)
      throwInvalid(path, `origin revision conflicts with ${revision.path}`);
    revisions.set(node.origin, { contentHash: node.contentHash, path });
    colors.set(nodeId, 1);
    for (const [parentIndex, parentId] of node.parents.entries()) {
      const parent = nodes.get(parentId);
      if (parent === undefined)
        throwInvalid(
          `${path}.parents[${parentIndex}]`,
          `dangling parent node ${parentId}`
        );
      visit(parentId, `${path}.parents[${parentIndex}] -> ${parent.origin}`);
    }
    verifyNode(node, path);
    for (const atom of node.atoms) {
      const firstPath = classPaths.get(atom.className);
      const firstAtomId = atomIdByClassName.get(atom.className);
      if (firstAtomId !== undefined && firstAtomId !== atom.atomId)
        throwInvalid(
          path,
          `class name ${atom.className} maps to different CSS content, condition, or property than ${firstPath}`
        );
      atomById.set(atom.atomId, atom);
      atomIdByClassName.set(atom.className, atom.atomId);
      classPaths.set(atom.className, path);
    }
    producerOrigins.push(node.origin);
    const styleOrigin = node.origin.slice(0, node.origin.indexOf(":"));
    if (!styles.has(styleOrigin)) {
      styles.add(styleOrigin);
      styleOrigins.push(styleOrigin);
    }
    colors.set(nodeId, 2);
  }

  for (const rootId of roots) {
    const root = nodes.get(rootId);
    if (root === undefined)
      throwInvalid("rootNodeId", `missing root node ${rootId}`);
    visit(rootId, root.origin);
  }
  return { atomById, atomIdByClassName, producerOrigins, styleOrigins };
}

function readArtifact(
  value: unknown,
  path: string
): { readonly rootNodeId: string; readonly nodes: readonly GraphNode[] } {
  const artifact = readRecord(value, path, [
    "schema",
    "version",
    "rootNodeId",
    "nodes"
  ]);
  if (
    artifact["schema"] !== "mincho.defineRulesPreset" ||
    artifact["version"] !== 5
  )
    throwInvalid(`${path}.version`, "expected defineRules preset version 5");
  const rootNodeId = readNodeId(artifact["rootNodeId"], `${path}.rootNodeId`);
  const nodes = readArray(artifact["nodes"], `${path}.nodes`).map(
    (node, index) => readNode(node, `${path}.nodes[${index}]`)
  );
  return { rootNodeId, nodes };
}

function readNode(value: unknown, path: string): GraphNode {
  const node = readRecord(value, path, [
    "nodeId",
    "origin",
    "contentHash",
    "parents",
    "atoms"
  ]);
  const origin = readOrigin(node["origin"], `${path}.origin`);
  const parents = readArray(node["parents"], `${origin}.parents`).map(
    (parent, index) => readNodeId(parent, `${origin}.parents[${index}]`)
  );
  const atoms = readArray(node["atoms"], `${origin}.atoms`).map((atom, index) =>
    readAtom(atom, `${origin}.atoms[${index}]`)
  );
  return {
    nodeId: readNodeId(node["nodeId"], `${origin}.nodeId`),
    origin,
    contentHash: readContentHash(node["contentHash"], `${origin}.contentHash`),
    parents,
    atoms
  };
}

function readAtom(value: unknown, path: string): DefineRulesPresetAtomV5 {
  const atom = readRecord(value, path, [
    "atomId",
    "cacheKey",
    "className",
    "condition",
    "property"
  ]);
  const parsed = createDefineRulesPresetAtomV5({
    cacheKey: readString(atom["cacheKey"], `${path}.cacheKey`),
    className: readString(atom["className"], `${path}.className`),
    condition: readCondition(atom["condition"], `${path}.condition`),
    property: readString(atom["property"], `${path}.property`)
  });
  if (parsed.atomId !== readAtomId(atom["atomId"], `${path}.atomId`))
    throwInvalid(path, "claimed atom ID does not recompute");
  return parsed;
}

function verifyNode(node: GraphNode, path: string): void {
  const contentHash = hashPresetCanonical({
    parents: node.parents,
    atoms: node.atoms
  });
  if (
    contentHash !== node.contentHash ||
    hashPresetCanonical({ origin: node.origin, contentHash }) !== node.nodeId
  )
    throwInvalid(path, "claimed node hashes do not recompute");
}

function sameNode(left: GraphNode, right: GraphNode): boolean {
  return (
    left.origin === right.origin &&
    left.contentHash === right.contentHash &&
    hashPresetCanonical({ parents: left.parents, atoms: left.atoms }) ===
      hashPresetCanonical({ parents: right.parents, atoms: right.atoms })
  );
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
