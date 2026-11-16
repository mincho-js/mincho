/** Track waits across independent async preparations, beyond local ancestry. */
export class PreparationGraph {
  private readonly waits = new Map<string, Map<string, number>>();
  private readonly failures = new Map<string, Error>();

  clear(): void {
    this.waits.clear();
    this.failures.clear();
  }

  private route(
    from: string,
    to: string,
    seen = new Set<string>()
  ): string[] | undefined {
    if (from === to) return [from];
    if (seen.has(from)) return;
    seen.add(from);
    for (const next of this.waits.get(from)?.keys() ?? []) {
      const route = this.route(next, to, seen);
      if (route) return [from, ...route];
    }
  }

  private cycleParticipants(from: string, to: string): Set<string> {
    const reachable = new Set<string>();
    const predecessors = new Map<string, Set<string>>();
    const pending = [from];
    while (pending.length) {
      const current = pending.pop()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const next of this.waits.get(current)?.keys() ?? []) {
        const incoming = predecessors.get(next) ?? new Set<string>();
        incoming.add(current);
        predecessors.set(next, incoming);
        pending.push(next);
      }
    }

    // Every reachable node that can also reach the owner joins the component
    // closed by owner -> dependency, including branches outside the first route.
    const participants = new Set<string>();
    pending.push(to);
    while (pending.length) {
      const current = pending.pop()!;
      if (participants.has(current)) continue;
      participants.add(current);
      pending.push(...(predecessors.get(current) ?? []));
    }
    return participants;
  }

  async wait<T, Fallback = never>(
    owner: string | undefined,
    dependency: string,
    load: () => Promise<T>,
    onCycle?: () => Fallback | Promise<Fallback>
  ): Promise<T | Fallback> {
    const previous = this.failures.get(dependency);
    if (previous) throw previous;
    let edges: Map<string, number> | undefined;
    if (owner) {
      const route = this.route(dependency, owner);
      if (route) {
        if (onCycle) return onCycle();
        const error = new Error(
          `Circular script preparation: ${[owner, ...route].join(" -> ")}. Move shared styles into a separate module.`
        );
        for (const file of this.cycleParticipants(dependency, owner))
          this.failures.set(file, error);
        throw error;
      }
      edges = this.waits.get(owner) ?? new Map();
      edges.set(dependency, (edges.get(dependency) ?? 0) + 1);
      this.waits.set(owner, edges);
    }
    try {
      const result = await load();
      // A consumer may catch an unavailable proof. A cycle is a build error,
      // so it must never silently publish a partial source from that task.
      const failure = this.failures.get(dependency);
      if (failure) throw failure;
      return result;
    } finally {
      if (edges) {
        const count = edges.get(dependency)! - 1;
        if (count) edges.set(dependency, count);
        else edges.delete(dependency);
        if (edges.size === 0 && this.waits.get(owner!) === edges)
          this.waits.delete(owner!);
      }
    }
  }
}
