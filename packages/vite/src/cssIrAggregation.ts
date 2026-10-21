import type { InternalVanillaCssArtifact } from "@mincho-js/integration";

/** Live immutable owners and a reverse resource index; removal never relies on refcounts. */
export class CssIrAggregation {
  private readonly nodes = new Map<
    string,
    {
      tokens: Set<string>;
      definitions: Set<string>;
      provenance: InternalVanillaCssArtifact["provenance"];
    }
  >();
  private readonly references = new Map<string, Set<string>>();
  private readonly facts = new WeakMap<
    InternalVanillaCssArtifact["cssObjs"],
    { tokens: Set<string>; definitions: Set<string> }
  >();
  private groups: string[][] = [];

  clear(): void {
    this.nodes.clear();
    this.references.clear();
    this.groups = [];
  }

  update(
    input: ReadonlyMap<string, InternalVanillaCssArtifact>
  ): readonly string[][] {
    let changed = false;

    for (const [id, node] of this.nodes)
      if (!input.has(id) || input.get(id)!.provenance !== node.provenance) {
        changed = true;

        for (const token of node.tokens) {
          const owners = this.references.get(token)!;
          owners.delete(id);

          if (!owners.size) this.references.delete(token);
        }

        this.nodes.delete(id);
      }

    for (const [id, artifact] of input)
      if (!this.nodes.has(id)) {
        changed = true;

        const cached = this.facts.get(artifact.cssObjs);
        const tokens = new Set(cached?.tokens);
        const definitions = new Set(
          cached?.definitions ?? artifact.localClassNames
        );

        const scan = (value: unknown): void => {
          if (typeof value === "string")
            for (const token of value.match(
              /--[A-Za-z_][\w-]*|[A-Za-z_][\w-]*/g
            ) ?? [])
              tokens.add(token);
          else if (value && typeof value === "object")
            for (const [key, child] of Object.entries(value)) {
              if (key === "vars" && child && typeof child === "object")
                for (const name of Object.keys(child)) {
                  const variable =
                    /^var\((--[\w-]+)\)$/.exec(name)?.[1] ?? name;

                  definitions.add(variable);
                  tokens.add(variable);
                }
              if (key === "selectors") scan(Object.keys(child as object));

              scan(child);
            }
        };

        if (!cached) {
          scan(artifact.cssObjs);
          scan(artifact.composedClassLists);

          for (const root of artifact.cssObjs)
            if (root.type === "keyframes" || root.type === "property")
              definitions.add(root.name);

          this.facts.set(artifact.cssObjs, {
            tokens: new Set(tokens),
            definitions: new Set(definitions)
          });
        }

        scan(artifact.provenance?.resources?.recipes);
        scan(artifact.provenance?.resources?.recipeUses);
        scan(artifact.provenance?.publicReferences);

        for (const root of artifact.cssObjs)
          if (root.type === "keyframes" || root.type === "property")
            definitions.add(root.name);

        for (const name of definitions) tokens.add(name);

        this.nodes.set(id, {
          tokens,
          definitions,
          provenance: artifact.provenance
        });

        for (const token of tokens) {
          const owners = this.references.get(token) ?? new Set<string>();
          owners.add(id);
          this.references.set(token, owners);
        }
      }

    if (!changed) return this.groups;

    const edges = new Map(
      [...this.nodes.keys()].map((id) => [id, new Set<string>()])
    );

    for (const [id, node] of this.nodes)
      for (const name of node.definitions)
        for (const owner of this.references.get(name) ?? []) {
          edges.get(id)!.add(owner);
          edges.get(owner)!.add(id);
        }

    const unseen = new Set(this.nodes.keys());
    this.groups = [];

    while (unseen.size) {
      const queue = [unseen.values().next().value!];
      unseen.delete(queue[0]!);

      for (let index = 0; index < queue.length; index++)
        for (const id of edges.get(queue[index]!)!)
          if (unseen.delete(id)) queue.push(id);

      this.groups.push(queue.sort());
    }

    return this.groups;
  }
}
