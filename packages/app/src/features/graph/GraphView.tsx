import { useRef } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  type NodeTypes,
} from '@xyflow/react';
import { Layout, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UndoRedoButtons } from '@/components/UndoRedoButtons';
import { cn } from '@/lib/utils';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { GroupNode } from './GroupNode';
import { SelectionMenu } from './SelectionMenu';
import { InlineCreateInput } from './InlineCreateInput';
import { PAGE_VIEWPORT_MAX_ZOOM } from './usePageViewportLifecycle';
import { useGraphModel } from './useGraphModel';
import { useGraphCommands } from './useGraphCommands';
import { useGraphLayout } from './useGraphLayout';

const nodeTypes: NodeTypes = { task: TaskNode, group: GroupNode };
const MINI_MAP_STYLE = { width: 160, height: 110 } as const;
function miniMapNodeColor(node: RFNode) {
  const status = (node.data as TaskNodeData | undefined)?.status;
  if (status === 'done') return 'hsl(var(--muted-foreground) / 0.6)';
  if (status === 'doing') return 'hsl(var(--primary))';
  return 'hsl(var(--muted-foreground) / 0.35)';
}

function GraphViewInner({ viewportScope }: { viewportScope: 'desktop' | 'mobile' }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const model = useGraphModel();
  const { rfNodes, rfEdges, isNodeDragging } = model;
  const commands = useGraphCommands({ ...model, containerRef });
  const {
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
  } = commands;
  const {
    applyAutoLayout,
    fitView,
    minZoom,
    isViewportMoving,
    isViewportRestoring,
    onMoveStart,
    onMoveEnd,
  } = useGraphLayout({ ...model, containerRef, viewportScope });
  return (
    <div
      ref={containerRef}
      className={`graph-surface relative h-full w-full${isViewportMoving ? ' graph-viewport-moving' : ''}${isNodeDragging ? ' graph-node-dragging' : ''}${isViewportRestoring ? ' graph-viewport-restoring' : ''}`}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
      onMouseMove={handleContainerMouseMove}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="graph-toolbar absolute left-3 right-3 top-3 z-10 flex items-center justify-center gap-2 rounded-xl border border-border bg-card/90 p-2 backdrop-blur lg:right-auto lg:justify-start lg:rounded-lg">
        <span className="text-xs text-muted-foreground hidden lg:inline">
          拖 <b>●</b> 连边；拖到空白处创建新节点；<kbd className="text-[10px]">Shift</kbd>+左键框选
        </span>
        <div className="mx-1 h-4 w-px bg-border" />
        <UndoRedoButtons />
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="outline"
          size="sm"
          className="h-8 min-w-9 gap-1 px-2 lg:h-7 lg:min-w-0"
          onClick={applyAutoLayout}
        >
          <Layout className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">自动布局</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 min-w-9 gap-1 px-2 lg:h-7 lg:min-w-0"
          onClick={fitView}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">适配</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs lg:h-7"
          disabled={selectedNodeIds.length < 1}
          onClick={() => void promptMoveSelectionToPage()}
          title={selectedNodeIds.length < 1 ? '先选中节点' : '移到已有页面或新建页面'}
        >
          移到页面
        </Button>
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        {...model.handlers}
        {...commands.handlers}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        connectionRadius={48}
        minZoom={minZoom}
        maxZoom={PAGE_VIEWPORT_MAX_ZOOM}
        defaultEdgeOptions={{ interactionWidth: 32 }}
        onlyRenderVisibleElements={viewportScope === 'mobile'}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background gap={24} size={1} color="hsl(var(--border))" />
        <Controls />
        {!isViewportRestoring && (
          <MiniMap
            pannable
            zoomable
            ariaLabel="概览"
            position="bottom-right"
            nodeColor={miniMapNodeColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="hsl(var(--background) / 0.6)"
            maskStrokeColor="hsl(var(--border))"
            maskStrokeWidth={1}
            className={cn(
              '!bg-card/80 !border-border !rounded-lg !shadow-md',
              viewportScope === 'mobile' ? 'graph-minimap-mobile' : 'backdrop-blur',
            )}
            style={MINI_MAP_STYLE}
          />
        )}
      </ReactFlow>

      {pendingCreate && (
        <InlineCreateInput onCommit={commitPendingCreate} onCancel={cancelPendingCreate} />
      )}

      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          actions={selectionActions}
          onClose={closeSelectionMenu}
        />
      )}
    </div>
  );
}

export function GraphView({ viewportScope }: { viewportScope: 'desktop' | 'mobile' }) {
  return (
    <ReactFlowProvider>
      <GraphViewInner viewportScope={viewportScope} />
    </ReactFlowProvider>
  );
}
