import { z } from 'zod';

export const HeapGraphSchema = z.object({
  version: z.literal(3),
  type: z.literal('Inspector'),
  nodes: z.array(z.number().int().nonnegative()),
  nodeClassNames: z.array(z.string()),
  edges: z.array(z.number().int().nonnegative()),
  edgeTypes: z.array(z.string()),
  edgeNames: z.array(z.string()),
});

/** Paths describe classes and edge kinds only; arbitrary property names may contain payload data. */
export function retainingPaths(value: unknown, target: string, limit = 3) {
  const graph = HeapGraphSchema.parse(value);
  if (graph.nodes.length % 4 !== 0 || graph.edges.length % 4 !== 0) throw new Error('incomplete heap graph');
  const nodes = new Map<number, string>();
  for (let offset = 0; offset < graph.nodes.length; offset += 4) {
    const id = graph.nodes[offset];
    const index = graph.nodes[offset + 2];
    const name = index === undefined ? undefined : graph.nodeClassNames[index];
    if (id === undefined || name === undefined || nodes.has(id)) throw new Error('invalid heap node');
    nodes.set(id, name);
  }
  if (!nodes.has(0)) throw new Error('heap graph has no root');
  const outgoing = new Map<number, Array<{ to: number; kind: string }>>();
  for (let offset = 0; offset < graph.edges.length; offset += 4) {
    const from = graph.edges[offset];
    const to = graph.edges[offset + 1];
    const kindIndex = graph.edges[offset + 2];
    const kind = kindIndex === undefined ? undefined : graph.edgeTypes[kindIndex];
    if (from === undefined || to === undefined || !nodes.has(from) || !nodes.has(to) || kind === undefined)
      throw new Error('invalid heap edge');
    const list = outgoing.get(from) ?? [];
    list.push({ to, kind });
    outgoing.set(from, list);
  }
  const parent = new Map<number, { from: number; kind: string }>();
  const queue = [0];
  const seen = new Set([0]);
  const paths: Array<Array<{ type: string; edge: string }>> = [];
  for (let position = 0; position < queue.length && paths.length < limit; position++) {
    const id = queue[position];
    if (id === undefined) throw new Error('incomplete graph traversal');
    if (nodes.get(id) === target) {
      const path: Array<{ type: string; edge: string }> = [];
      let current = id;
      for (;;) {
        const type = nodes.get(current);
        if (type === undefined) throw new Error('missing heap parent');
        const previous = parent.get(current);
        path.push({ type, edge: previous?.kind ?? 'root' });
        if (previous === undefined) break;
        current = previous.from;
      }
      paths.push(path.reverse());
    }
    for (const edge of outgoing.get(id) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      parent.set(edge.to, { from: id, kind: edge.kind });
      queue.push(edge.to);
    }
  }
  return paths;
}
