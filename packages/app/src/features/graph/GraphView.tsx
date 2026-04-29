import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { Layout, Maximize2 } from 'lucide-react';
import { wouldCreateCycle } from '@todograph/core';
import { Button } from '@/components/ui/button';
import { useTaskStore } from '@/stores/useTaskStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { dagreLayout } from './useAutoLayout';

const nodeTypes: NodeTypes = { task: TaskNode };

function GraphViewInner() {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const addEdge = useTaskStore((s) => s.addEdge);
  const removeEdge = useTaskStore((s) => s.removeEdge);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const { graph, readySet, recommended } = useDerived();
  const rf = useReactFlow();

  // ===== 本地 nodes state =====
  // React Flow 拖动的位置先只更新本地 state（实时响应），
  // 拖动结束后才把新坐标 flush 回 zustand store（落盘）。
  // 否则 store → re-render 有防抖/异步不等开销，拖动过程会卡顿。
  const [rfNodes, setRfNodes] = useState<RFNode<TaskNodeData>[]>([]);
  const draggingRef = useRef(false);

  // 当 store 的 nodes / 派生数据变化时，同步到本地 state；
  // 但如果正在拖动，绝对不能覆盖本地位置（否则刚拖的节点会弹回去）。
  useEffect(() => {
    if (draggingRef.current) return;
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      return nodes.map((n) => {
        const old = prevById.get(n.id);
        return {
          id: n.id,
          type: 'task',
          // 优先采用本地位置（如果存在且与 store 一致则无差异；
          // 如果用户在拖后已 flush，store 与本地位置一致；
          // 如果是新节点或首次加载，用 store 的 x/y）。
          position: old?.position ?? { x: n.x ?? 0, y: n.y ?? 0 },
          data: {
            title: n.title,
            status: n.status,
            priority: n.priority,
            ready: readySet.has(n.id),
            recommended: recommended?.id === n.id,
          },
        };
      });
    });
  }, [nodes, readySet, recommended]);

  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map((e) => {
        const from = nodes.find((n) => n.id === e.from);
        const isReady = from?.status === 'done';
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          animated: isReady,
          className: isReady ? 'ready' : undefined,
        };
      }),
    [edges, nodes],
  );

  /** 接管节点拖动：实时更新本地 state；drag end 时写回 store。 */
  const onNodesChange = useCallback(
    (changes: NodeChange<RFNode<TaskNodeData>>[]) => {
      // 先把 position 变化应用到本地 state 以获得流畅动画
      setRfNodes((prev) => applyNodeChanges(changes, prev));

      // 跟踪 dragging 状态
      for (const c of changes) {
        if (c.type === 'position') {
          if (c.dragging) {
            draggingRef.current = true;
          } else if (c.id) {
            // 拖动结束：把该节点的最终位置写回 store
            draggingRef.current = false;
            setRfNodes((curr) => {
              const n = curr.find((x) => x.id === c.id);
              if (n) updateTask(c.id!, { x: n.position.x, y: n.position.y });
              return curr;
            });
          }
        }
        if (c.type === 'remove' && c.id) {
          deleteTask(c.id);
        }
      }
    },
    [updateTask, deleteTask],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) addEdge(c.source, c.target);
    },
    [addEdge],
  );

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      const source = (c as Connection).source ?? (c as RFEdge).source;
      const target = (c as Connection).target ?? (c as RFEdge).target;
      if (!source || !target || source === target) return false;
      return !wouldCreateCycle(graph, source, target);
    },
    [graph],
  );

  const onEdgeClick = useCallback(
    (_evt: React.MouseEvent, e: RFEdge) => {
      if (confirm('删除这条依赖?')) removeEdge(e.source, e.target);
    },
    [removeEdge],
  );

  const applyAutoLayout = useCallback(() => {
    const { nodes: laid } = dagreLayout(rfNodes, rfEdges);
    // 先更新本地 state 让画面立刻刷新
    setRfNodes((prev) => {
      const byId = new Map(laid.map((n) => [n.id, n.position]));
      return prev.map((p) => ({ ...p, position: byId.get(p.id) ?? p.position }));
    });
    // 再把布局结果写回 store（落盘）
    for (const n of laid) updateTask(n.id, { x: n.position.x, y: n.position.y });
    setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
  }, [rfNodes, rfEdges, updateTask, rf]);

  // 初次进入图视图若所有节点都在 (0,0) 附近则自动布局一次
  useEffect(() => {
    const allAtOrigin = nodes.length > 0 && nodes.every((n) => !n.x && !n.y);
    if (allAtOrigin) applyAutoLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-full w-full">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          拖节点右侧 <b>●</b> 到另一节点建立依赖；点击边可删除
        </span>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="outline" size="sm" className="gap-1 h-7" onClick={applyAutoLayout}>
          <Layout className="h-3.5 w-3.5" />
          自动布局
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1 h-7"
          onClick={() => rf.fitView({ padding: 0.2 })}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          适配
        </Button>
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        {/* 纯净背景：去掉点点 */}
        <Controls />
        <MiniMap
          pannable
          zoomable
          ariaLabel="概览"
          position="bottom-right"
          // 节点颜色按状态区分；用 CSS 变量让主题切换时自动跟随
          nodeColor={(node) => {
            const s = (node.data as TaskNodeData | undefined)?.status;
            if (s === 'done') return 'hsl(var(--muted-foreground) / 0.6)';
            if (s === 'doing') return 'hsl(var(--primary))';
            return 'hsl(var(--muted-foreground) / 0.35)';
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={3}
          maskColor="hsl(var(--background) / 0.6)"
          maskStrokeColor="hsl(var(--border))"
          maskStrokeWidth={1}
          className="!bg-card/80 !border-border !rounded-lg !shadow-md backdrop-blur"
          style={{ width: 160, height: 110 }}
        />
      </ReactFlow>
    </div>
  );
}

export function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphViewInner />
    </ReactFlowProvider>
  );
}
