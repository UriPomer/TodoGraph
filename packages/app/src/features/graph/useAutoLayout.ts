import dagre from 'dagre';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import {
  CHILD_DEFAULT_W,
  CHILD_DEFAULT_H,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  capGroupSize,
  computeGroupSize,
} from '@todograph/shared';

const GROUP_CHILD_GAP_X = 24;
const GROUP_CHILD_GAP_Y = 16;

export function layoutChildrenInTwoColumns<NodeData extends Record<string, unknown>>(
  children: RFNode<NodeData>[],
  sizeOf: (node: RFNode<NodeData>) => { width: number; height: number },
): { positions: Map<string, { x: number; y: number }>; size: { w: number; h: number } } {
  const ordered = [...children].sort(
    (left, right) => left.position.y - right.position.y || left.position.x - right.position.x,
  );
  const sizes = ordered.map(sizeOf);
  const firstColumnWidth = Math.max(
    0,
    ...sizes.filter((_, index) => index % 2 === 0).map((size) => size.width),
  );
  const positions = new Map<string, { x: number; y: number }>();
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  let y = GROUP_PADDING_Y;

  for (let row = 0; row * 2 < ordered.length; row++) {
    const firstIndex = row * 2;
    const rowIndexes = [firstIndex, firstIndex + 1].filter((index) => index < ordered.length);
    const rowHeight = Math.max(...rowIndexes.map((index) => sizes[index]!.height));
    for (const index of rowIndexes) {
      const node = ordered[index]!;
      const size = sizes[index]!;
      const x = index % 2 === 0
        ? GROUP_PADDING_X
        : GROUP_PADDING_X + firstColumnWidth + GROUP_CHILD_GAP_X;
      positions.set(node.id, { x, y });
      rects.push({ x, y, w: size.width, h: size.height });
    }
    y += rowHeight + GROUP_CHILD_GAP_Y;
  }

  return { positions, size: computeGroupSize(rects) };
}

export function layoutNestedGroupChildren<NodeData extends Record<string, unknown>>(
  nodes: RFNode<NodeData>[],
  groupIdsDeepestFirst: string[],
  childrenByParent: ReadonlyMap<string, string[]>,
  sizeOf: (node: RFNode<NodeData>) => { width: number; height: number },
): {
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, { width: number; height: number }>;
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  const sizes = new Map(nodes.map((node) => [node.id, sizeOf(node)]));

  for (const parentId of groupIdsDeepestFirst) {
    const children = (childrenByParent.get(parentId) ?? [])
      .map((id) => {
        const node = byId.get(id);
        if (!node) throw new Error(`missing layout child ${id} for group ${parentId}`);
        return { ...node, position: positions.get(id)! };
      });
    const layout = layoutChildrenInTwoColumns(children, (node) => sizes.get(node.id)!);
    for (const [id, position] of layout.positions) positions.set(id, position);
    const displayedSize = capGroupSize(layout.size);
    sizes.set(parentId, { width: displayedSize.w, height: displayedSize.h });
  }

  return { positions, sizes };
}

/**
 * 基于 dagre 的左→右层级布局。
 * 返回新的 nodes 数组（带 position），edges 原样返回。
 *
 * @param sizeOf 可选：自定义节点尺寸映射。用于给父节点传入真实包围盒尺寸，
 *               这样 dagre 给父节点留出合适的行列间距，不会让兄弟节点撞上父框。
 */
export function dagreLayout<NodeData extends Record<string, unknown>>(
  nodes: RFNode<NodeData>[],
  edges: RFEdge[],
  sizeOf?: (n: RFNode<NodeData>) => { width: number; height: number },
): { nodes: RFNode<NodeData>[]; edges: RFEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  for (const n of nodes) {
    const s = sizeOf?.(n) ?? { width: CHILD_DEFAULT_W, height: CHILD_DEFAULT_H };
    g.setNode(n.id, s);
  }
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const laid = nodes.map((n) => {
    const p = g.node(n.id);
    const s = sizeOf?.(n) ?? { width: CHILD_DEFAULT_W, height: CHILD_DEFAULT_H };
    return {
      ...n,
      // dagre 返回中心点坐标，React Flow 期望左上角
      position: { x: p.x - s.width / 2, y: p.y - s.height / 2 },
    };
  });
  return { nodes: laid, edges };
}
