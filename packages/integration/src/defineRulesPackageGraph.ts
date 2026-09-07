/** The validated V5 fields needed here, independent of module-format ID brands. */
export interface DefineRulesPackageGraphArtifact {
  readonly rootNodeId: string;
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly origin: string;
    readonly parents: readonly string[];
  }[];
}

export interface DefineRulesPackageDependencyWitness {
  readonly parentOrigin: string;
  readonly childOrigin: string;
  readonly parentNodeId: string;
  readonly childNodeId: string;
  readonly owner?: string;
}

export interface DefineRulesPackageGraph {
  readonly packages: readonly {
    readonly packageName: string;
    readonly firstSeen: number;
  }[];
  readonly dependencies: readonly {
    readonly dependency: string;
    readonly dependent: string;
    readonly witnesses: readonly DefineRulesPackageDependencyWitness[];
  }[];
  readonly localPackages: readonly string[];
}

type MutableDependency = {
  dependency: string;
  dependent: string;
  witnesses: DefineRulesPackageDependencyWitness[];
  witnessKeys: Set<string>;
};

function createGraphBuilder() {
  const packages = new Map<string, number>();
  const dependencies = new Map<string, MutableDependency>();
  const localPackages = new Set<string>();

  function addPackage(packageName: string): void {
    if (!packages.has(packageName)) packages.set(packageName, packages.size);
  }

  function addDependency(
    dependency: string,
    dependent: string,
    witnesses: readonly DefineRulesPackageDependencyWitness[]
  ): void {
    if (dependency === dependent) return;

    const key = JSON.stringify([dependency, dependent]);
    let edge = dependencies.get(key);

    if (edge === undefined) {
      edge = { dependency, dependent, witnesses: [], witnessKeys: new Set() };
      dependencies.set(key, edge);
    }

    for (const witness of witnesses) {
      const witnessKey = JSON.stringify([
        witness.parentNodeId,
        witness.childNodeId,
        witness.owner
      ]);
      if (edge.witnessKeys.has(witnessKey)) continue;

      edge.witnessKeys.add(witnessKey);
      edge.witnesses.push(Object.freeze({ ...witness }));
    }
  }

  function finish(): DefineRulesPackageGraph {
    return Object.freeze({
      packages: Object.freeze(
        [...packages].map(([packageName, firstSeen]) =>
          Object.freeze({ packageName, firstSeen })
        )
      ),
      dependencies: Object.freeze(
        [...dependencies.values()].map(({ dependency, dependent, witnesses }) =>
          Object.freeze({
            dependency,
            dependent,
            witnesses: Object.freeze(witnesses)
          })
        )
      ),
      localPackages: Object.freeze([...localPackages])
    });
  }

  return { addPackage, addDependency, localPackages, finish };
}

/** Collect package constraints from already validated V5 root ancestries. */
export function collectDefineRulesPackageGraph(
  artifacts: readonly DefineRulesPackageGraphArtifact[],
  options: { readonly owner?: string } = {}
): DefineRulesPackageGraph {
  const graph = createGraphBuilder();
  const visited = new Set<string>();

  for (const artifact of artifacts) {
    const nodes = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
    const root = nodes.get(artifact.rootNodeId);
    if (root === undefined) {
      throw new TypeError("defineRules preset root node is missing");
    }

    graph.localPackages.add(getOriginPackage(root.origin));

    const activeNodes = new Set<string>([root.nodeId]);
    const stack = [{ node: root, nextParent: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const { node } = frame;

      if (visited.has(node.nodeId)) {
        activeNodes.delete(node.nodeId);
        stack.pop();
        continue;
      }

      if (frame.nextParent < node.parents.length) {
        const parent = nodes.get(node.parents[frame.nextParent++]);
        if (parent === undefined) {
          throw new TypeError(
            `defineRules preset parent node is missing: ${node.parents[frame.nextParent - 1]}`
          );
        }
        if (activeNodes.has(parent.nodeId)) {
          throw new TypeError(
            `defineRules preset node cycle: ${node.origin} -> ${parent.origin}`
          );
        }

        if (!visited.has(parent.nodeId)) {
          activeNodes.add(parent.nodeId);
          stack.push({ node: parent, nextParent: 0 });
        }

        continue;
      }

      // Preserve the former collector's parent-first encounter order for ties.
      const dependent = getOriginPackage(node.origin);
      graph.addPackage(dependent);

      for (const parentId of node.parents) {
        const parent = nodes.get(parentId);
        if (parent === undefined) {
          throw new TypeError(
            `defineRules preset parent node is missing: ${parentId}`
          );
        }

        graph.addDependency(getOriginPackage(parent.origin), dependent, [
          {
            parentOrigin: parent.origin,
            childOrigin: node.origin,
            parentNodeId: parent.nodeId,
            childNodeId: node.nodeId,
            ...(options.owner === undefined ? {} : { owner: options.owner })
          }
        ]);
      }

      visited.add(node.nodeId);
      activeNodes.delete(node.nodeId);
      stack.pop();
    }
  }

  return graph.finish();
}

/** Union independently collected modules before deriving an output's CSS order. */
export function mergeDefineRulesPackageGraphs(
  graphs: readonly DefineRulesPackageGraph[]
): DefineRulesPackageGraph {
  const merged = createGraphBuilder();

  for (const graph of graphs) {
    for (const node of [...graph.packages].sort(
      (left, right) => left.firstSeen - right.firstSeen
    )) {
      merged.addPackage(node.packageName);
    }

    for (const edge of graph.dependencies) {
      merged.addDependency(edge.dependency, edge.dependent, edge.witnesses);
    }

    for (const packageName of graph.localPackages) {
      merged.localPackages.add(packageName);
    }
  }

  return merged.finish();
}

/** Check the complete graph, then omit packages whose CSS is emitted locally. */
export function getDefineRulesPackageStyleSpecifiers(
  graph: DefineRulesPackageGraph,
  options: { readonly excludePackages?: readonly string[] } = {}
): string[] {
  const order = sortDefineRulesPackages(graph);
  const excluded = new Set(options.excludePackages ?? graph.localPackages);

  return order
    .filter((packageName) => !excluded.has(packageName))
    .map((packageName) => `${packageName}/style.css`);
}

function getOriginPackage(origin: string): string {
  const separator = origin.indexOf(":");
  if (separator === -1) {
    throw new TypeError(
      `defineRules preset origin is missing a package separator: ${origin}`
    );
  }

  return origin.slice(0, separator);
}

function sortDefineRulesPackages(graph: DefineRulesPackageGraph): string[] {
  const packages = [...graph.packages].sort(
    (left, right) => left.firstSeen - right.firstSeen
  );

  const indices = new Map(
    packages.map((node, index) => [node.packageName, index])
  );

  const indegrees = new Uint32Array(packages.length);
  const successors = packages.map(() => [] as number[]);

  for (const edge of graph.dependencies) {
    const source = indices.get(edge.dependency);
    const target = indices.get(edge.dependent);
    if (source === undefined || target === undefined) {
      throw new Error("defineRules package graph contains an unknown package");
    }

    successors[source].push(target);
    indegrees[target]++;
  }

  // A min-heap avoids repeated array sorting on wide dependency graphs.
  const ready: number[] = [];

  const pushReady = (index: number): void => {
    let position = ready.length;
    ready.push(index);

    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (ready[parent] <= index) break;

      ready[position] = ready[parent];
      position = parent;
    }

    ready[position] = index;
  };

  const popReady = (): number => {
    const first = ready[0];
    const last = ready.pop()!;
    if (ready.length === 0) return first;

    let position = 0;

    while (position * 2 + 1 < ready.length) {
      let child = position * 2 + 1;

      if (child + 1 < ready.length && ready[child + 1] < ready[child]) child++;
      if (ready[child] >= last) break;

      ready[position] = ready[child];
      position = child;
    }

    ready[position] = last;

    return first;
  };

  for (let index = 0; index < packages.length; index++) {
    if (indegrees[index] === 0) pushReady(index);
  }

  const sorted: string[] = [];

  while (ready.length > 0) {
    const index = popReady();
    sorted.push(packages[index].packageName);

    for (const target of successors[index]) {
      if (--indegrees[target] === 0) pushReady(target);
    }
  }

  if (sorted.length !== packages.length) {
    throwPackageCycle(graph, packages, successors, indegrees);
  }

  return sorted;
}

function throwPackageCycle(
  graph: DefineRulesPackageGraph,
  packages: DefineRulesPackageGraph["packages"],
  successors: readonly (readonly number[])[],
  indegrees: Uint32Array
): never {
  const completed = new Set<number>();
  const active = new Map<number, number>();

  for (let index = 0; index < packages.length; index++) {
    if (indegrees[index] === 0 || completed.has(index)) continue;

    const stack = [{ index, next: 0 }];
    active.set(index, 0);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];

      if (frame.next === successors[frame.index].length) {
        completed.add(frame.index);
        active.delete(frame.index);
        stack.pop();
        continue;
      }

      const next = successors[frame.index][frame.next++];
      if (indegrees[next] === 0 || completed.has(next)) continue;

      const cycleStart = active.get(next);

      if (cycleStart !== undefined) {
        const cycle = stack
          .slice(cycleStart)
          .map(({ index: entry }) => packages[entry].packageName);

        cycle.push(packages[next].packageName);

        const edges = new Map(
          graph.dependencies.map((edge) => [
            JSON.stringify([edge.dependency, edge.dependent]),
            edge
          ])
        );

        const evidence = cycle.slice(1).map((dependent, edgeIndex) => {
          const dependency = cycle[edgeIndex];
          const witness = edges.get(JSON.stringify([dependency, dependent]))
            ?.witnesses[0];

          return witness === undefined
            ? `${dependency} -> ${dependent}`
            : `${witness.parentOrigin} -> ${witness.childOrigin}${
                witness.owner === undefined ? "" : ` (owner: ${witness.owner})`
              }`;
        });

        throw new Error(
          `defineRules automatic CSS package dependency cycle: ${cycle.join(" -> ")}\n${evidence.join("\n")}`
        );
      }

      active.set(next, stack.length);
      stack.push({ index: next, next: 0 });
    }
  }

  throw new Error("defineRules automatic CSS package dependency cycle");
}
