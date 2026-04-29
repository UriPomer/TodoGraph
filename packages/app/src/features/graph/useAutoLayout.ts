import dagre from 'dagre';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 56;

/**
 * 基于 dagre 的左→右层级布局。
 * 返回新的 nodes 数组（带 position），edges 原样返回。
 */
export function dagreLayout<NodeData extends Record<string, unknown>>(
  nodes: RFNode<NodeData>[],
  edges: RFEdge[],
): { nodes: RFNode<NodeData>[]; edges: RFEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const laid = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      // dagre 返回中心点坐标，React Flow 期望左上角
      position: { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 },
    };
  });
  return { nodes: laid, edges };
}
