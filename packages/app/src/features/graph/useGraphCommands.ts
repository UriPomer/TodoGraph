import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import { wouldCreateCycle } from '@todograph/core';
import {
  MAX_HIERARCHY_DEPTH,
  MAX_PAGE_TITLE_LENGTH,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_H,
} from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { worldPositionFromIndex } from '@/lib/taskHierarchy';
import { dialog } from '@/components/ui/dialog-store';
import type { SelectionMenuAction } from './SelectionMenu';
import { buildAlignedPatches } from './pageAutoLayout';
import { useTouchManager } from './useTouchManager';
import type { useGraphModel } from './useGraphModel';

type GraphCommandOptions = Pick<
  ReturnType<typeof useGraphModel>,
  'nodes' | 'graph' | 'activePageId' | 'hierarchyMetrics' | 'rfNodes'
> & { containerRef: RefObject<HTMLDivElement> };
type ConnectionStart = { nodeId: string; handleType: string | null };
interface PendingCreate {
  x: number;
  y: number;
  parentId?: string;
  connection?: ConnectionStart;
}

export function useGraphCommands({
  nodes,
  graph,
  activePageId,
  hierarchyMetrics,
  rfNodes,
  containerRef,
}: GraphCommandOptions) {
  const rf = useReactFlow();
  const addTask = useTaskStore((s) => s.addTask);
  const addEdge = useTaskStore((s) => s.addEdge);
  const removeEdge = useTaskStore((s) => s.removeEdge);
  const insertBetween = useTaskStore((s) => s.insertBetween);
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
  const deleteTasks = useTaskStore((s) => s.deleteTasks);
  const detachTasks = useTaskStore((s) => s.detachTasks);
  const groupTasks = useTaskStore((s) => s.groupTasks);
  const workspaceMeta = useWorkspaceStore((s) => s.meta);
  const moveNodesToPage = useWorkspaceStore((s) => s.moveNodesToPage);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const connectStartRef = useRef<ConnectionStart | null>(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const handleContainerMouseMove = useCallback((event: React.MouseEvent) => {
    lastMousePosRef.current = { x: event.clientX, y: event.clientY };
  }, []);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (
        (event.key !== ' ' && event.key !== 'Enter') ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      event.preventDefault();
      const selected = rf.getNodes().filter((node) => node.selected);
      const selectedId = selected.length === 1 ? selected[0]!.id : undefined;
      if (selectedId && hierarchyMetrics.childIdsByParentId.has(selectedId)) {
        if ((hierarchyMetrics.depthById.get(selectedId) ?? 0) + 1 >= MAX_HIERARCHY_DEPTH) return;
        const childY = Math.max(
          GROUP_PADDING_Y,
          ...nodes
            .filter((node) => node.parentId === selectedId)
            .map((node) => (node.y ?? 0) + CHILD_DEFAULT_H),
        );
        setPendingCreate({ x: GROUP_PADDING_X, y: childY + 12, parentId: selectedId });
        return;
      }
      const position = rf.screenToFlowPosition(lastMousePosRef.current);
      setPendingCreate({ x: position.x - 90, y: position.y - 28 });
    },
    [rf, nodes, hierarchyMetrics],
  );
  const isValidConnection = useCallback(
    (connection: Connection | RFEdge) => {
      const { source, target } = connection;
      return Boolean(
        source && target && source !== target && !wouldCreateCycle(graph, source, target),
      );
    },
    [graph],
  );
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    return () => document.removeEventListener('pointermove', onMove, { capture: true });
  }, []);
  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId: string | null; handleType: string | null }) => {
      connectStartRef.current = params.nodeId
        ? { nodeId: params.nodeId, handleType: params.handleType }
        : null;
    },
    [],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      connectStartRef.current = null;
      addEdge(connection.source, connection.target);
    },
    [addEdge],
  );
  const onConnectEnd = useCallback(() => {
    const start = connectStartRef.current;
    connectStartRef.current = null;
    const position = lastPointerRef.current;
    if (
      !start ||
      !position ||
      document
        .elementFromPoint(position.x, position.y)
        ?.closest('.react-flow__handle, .react-flow__node')
    )
      return;
    const flow = rf.screenToFlowPosition(position);
    setPendingCreate({ x: flow.x - 90, y: flow.y - 28, connection: start });
  }, [rf]);
  const commitPendingCreate = useCallback(
    (title: string) => {
      if (!pendingCreate) return;
      const { connection, ...position } = pendingCreate;
      const task = addTask({ title, ...position });
      if (!task) { setPendingCreate(null); return; }
      if (connection) {
        if (connection.handleType === 'target') addEdge(task.id, connection.nodeId);
        else addEdge(connection.nodeId, task.id);
      }
      setPendingCreate(null);
    },
    [pendingCreate, addTask, addEdge],
  );
  const cancelPendingCreate = useCallback(() => setPendingCreate(null), []);
  const hasPendingCreate = useCallback(() => pendingCreate !== null, [pendingCreate]);
  const onLongPressBlank = useCallback((x: number, y: number) => setPendingCreate({ x, y }), []);
  useTouchManager({
    containerRef,
    rf,
    hasPendingCreate,
    onLongPressBlank,
    onCancelPendingCreate: cancelPendingCreate,
  });
  const onEdgeClick = useCallback(
    async (_event: React.MouseEvent, edge: RFEdge) => {
      const pageId = useTaskStore.getState().activePageId;
      if (
        (await dialog.confirm('删除这条依赖?', { danger: true })) &&
        pageId === useTaskStore.getState().activePageId
      )
        removeEdge(edge.source, edge.target);
    },
    [removeEdge],
  );
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  const selectedNodeIds = useMemo(
    () => rfNodes.filter((node) => node.selected).map((node) => node.id),
    [rfNodes],
  );
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
  const showSelectionMenu = useCallback(
    (x: number, y: number, minimum = 1) => {
      const ids = rf
        .getNodes()
        .filter((node) => node.selected)
        .map((node) => node.id);
      const rect = containerRef.current?.getBoundingClientRect();
      if (ids.length >= minimum && rect)
        setSelectionMenu({ x: x - rect.left, y: y - rect.top, ids });
    },
    [rf, containerRef],
  );
  const onSelectionEnd = useCallback(
    (event: React.MouseEvent | MouseEvent) => showSelectionMenu(event.clientX, event.clientY),
    [showSelectionMenu],
  );
  const onNodeClick = useCallback(
    (event: React.MouseEvent, _node: RFNode) => {
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      const { clientX, clientY } = event;
      selectionTimerRef.current = setTimeout(() => {
        selectionTimerRef.current = null;
        showSelectionMenu(clientX, clientY, 2);
      }, 0);
    },
    [showSelectionMenu],
  );
  useEffect(() => {
    setPendingCreate(null);
    setSelectionMenu(null);
    connectStartRef.current = null;
    return () => {
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    };
  }, [activePageId]);
  const promptMoveSelectionToPage = useCallback(
    async (idsInput?: string[]) => {
      const ids = [...new Set(idsInput ?? selectedNodeIds)];
      if (ids.length === 0) return;
      if (!workspaceMeta) return;
      const idSet = new Set(ids);
      const selectedTasks = nodes.filter((n) => idSet.has(n.id));
      const [first] = [...selectedTasks].sort((left, right) => {
        const a = worldPositionFromIndex(hierarchyMetrics, left.id);
        const b = worldPositionFromIndex(hierarchyMetrics, right.id);
        return a.y - b.y || a.x - b.x || left.title.localeCompare(right.title);
      });
      const defaultTitle = first?.title.trim() || '新页面';
      const otherPages = workspaceMeta.pages.filter(
        (page) => page.id !== workspaceMeta.activePageId,
      );
      const raw = await dialog.prompt('移到页面', {
        defaultValue: defaultTitle,
        placeholder: `已有：${otherPages.map((p) => p.title).join(' / ')}` || '输入新页面名称',
        maxLength: MAX_PAGE_TITLE_LENGTH,
      });
      if (raw === null || useTaskStore.getState().activePageId !== activePageId) return;
      const title = raw.trim() || defaultTitle;
      const existing = otherPages.find((page) => page.title === title);
      if (existing) {
        await moveNodesToPage(ids, { pageId: existing.id });
      } else {
        await moveNodesToPage(ids, { newPageTitle: title });
      }
      setSelectionMenu(null);
    },
    [selectedNodeIds, nodes, workspaceMeta, moveNodesToPage, hierarchyMetrics, activePageId],
  );
  const selectionActions: SelectionMenuAction[] = useMemo(() => {
    if (!selectionMenu) return [];
    const ids = selectionMenu.ids;
    const firstId = ids[0];
    const nodesById = hierarchyMetrics.byId;
    const allHaveSameParent =
      firstId !== undefined &&
      ids.every((id) => nodesById.get(id)?.parentId === nodesById.get(firstId)?.parentId);
    return [
      {
        label: `归入新分组 (${ids.length})`,
        hint: '创建父任务',
        onClick: async () => {
          const title = await dialog.prompt('分组名称', { defaultValue: '新分组' });
          if (title === null || useTaskStore.getState().activePageId !== activePageId) return;
          groupTasks(ids, { title: title || '新分组' });
        },
        disabled: ids.length < 2,
      },
      {
        label: '在中间插入',
        hint: '依赖链插入',
        onClick: async () => {
          const title = await dialog.prompt('新任务名称', { defaultValue: '未命名' });
          if (title === null || useTaskStore.getState().activePageId !== activePageId) return;
          insertBetween(ids[0]!, ids[1]!, title || '未命名');
        },
        disabled: ids.length !== 2,
      },
      {
        label: '解除分组',
        hint: '清除 parentId',
        onClick: () => {
          detachTasks(ids);
        },
        disabled: !ids.some((id) => nodesById.get(id)?.parentId),
      },
      {
        label: '水平对齐',
        hint: '按首个节点 Y',
        onClick: () => {
          updateTasksBulk(buildAlignedPatches(nodes, ids, 'horizontal'));
        },
        disabled: ids.length < 2 || !allHaveSameParent,
      },
      {
        label: '垂直对齐',
        hint: '按首个节点 X',
        onClick: () => {
          updateTasksBulk(buildAlignedPatches(nodes, ids, 'vertical'));
        },
        disabled: ids.length < 2 || !allHaveSameParent,
      },
      {
        label: '移到页面',
        hint: ids.length > 1 ? `${ids.length} 个` : '跨页',
        onClick: () => {
          void promptMoveSelectionToPage(ids);
        },
      },
      {
        label: '删除选中',
        hint: `${ids.length} 个`,
        danger: true,
        onClick: async () => {
          const ok = await dialog.confirm(`删除选中的 ${ids.length} 个任务`, { danger: true });
          if (!ok || useTaskStore.getState().activePageId !== activePageId) return;
          deleteTasks(ids);
        },
      },
    ];
  }, [
    selectionMenu,
    nodes,
    hierarchyMetrics,
    groupTasks,
    detachTasks,
    updateTasksBulk,
    deleteTasks,
    promptMoveSelectionToPage,
    insertBetween,
    activePageId,
  ]);
  return {
    handleContainerMouseMove,
    handleKeyDown,
    pendingCreate,
    commitPendingCreate,
    cancelPendingCreate,
    selectionMenu,
    selectionActions,
    selectedNodeIds,
    promptMoveSelectionToPage,
    closeSelectionMenu,
    handlers: {
      onConnect,
      onConnectStart,
      onConnectEnd,
      isValidConnection,
      onEdgeClick,
      onNodeClick,
      onSelectionEnd,
    },
  };
}
