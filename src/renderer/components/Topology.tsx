import dagre from '@dagrejs/dagre';
import { Background, Controls, Handle, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import type { AgentDetail, AgentStatus } from '../../shared/types';
import { AgentCard } from './AgentCard';

const NODE_WIDTH = 300;

type AgentNodeData = { agent: AgentDetail; now: number; selected: boolean; onSelect: (id: string) => void };
type AgentNode = Node<AgentNodeData, 'agent'>;

function estimateHeight(agent: AgentDetail): number {
  let height = 118;
  if (agent.subtitle) height += 34;
  if (agent.nowTodo) height += 22;
  if (agent.currentAction || agent.error) height += 22;
  if (agent.title.length > 36) height += 18;
  return height;
}

function AgentNodeView({ data }: NodeProps<AgentNode>) {
  return (
    <div className="agent-node">
      <Handle type="target" position={Position.Top} isConnectable={false} className="agent-handle" />
      <AgentCard agent={data.agent} now={data.now} selected={data.selected} onSelect={data.onSelect} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="agent-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { agent: AgentNodeView };

const EDGE_COLOR: Record<AgentStatus, string> = {
  running: 'var(--running)',
  idle: 'var(--idle)',
  finished: 'var(--finished)',
  errored: 'var(--errored)',
};

function layout(agents: AgentDetail[], now: number, selectedId: string | undefined, onSelect: (id: string) => void): { nodes: AgentNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 70, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(agents.map((a) => a.id));
  for (const agent of agents) graph.setNode(agent.id, { width: NODE_WIDTH, height: estimateHeight(agent) });
  const edges: Edge[] = [];
  for (const agent of agents) {
    if (!agent.parentId || !ids.has(agent.parentId)) continue;
    graph.setEdge(agent.parentId, agent.id);
    edges.push({
      id: `${agent.parentId}->${agent.id}`,
      source: agent.parentId,
      target: agent.id,
      type: 'smoothstep',
      animated: agent.status === 'running',
      style: { stroke: EDGE_COLOR[agent.status], strokeWidth: agent.status === 'running' ? 2.2 : 1.6, opacity: agent.status === 'finished' ? 0.7 : 1 },
      ariaLabel: `${agent.parentId} spawned ${agent.title}`,
    });
  }
  dagre.layout(graph);
  const nodes: AgentNode[] = agents.map((agent) => {
    const pos = graph.node(agent.id);
    return {
      id: agent.id,
      type: 'agent',
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - pos.height / 2 },
      data: { agent, now, selected: agent.id === selectedId, onSelect },
      draggable: true,
      selectable: false,
      focusable: true,
      width: NODE_WIDTH,
      height: pos.height,
    };
  });
  return { nodes, edges };
}

function FitOnChange({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 300, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [signature, fitView]);
  return null;
}

export function Topology({ agents, now, selectedAgentId, onSelect }: { agents: AgentDetail[]; now: number; selectedAgentId: string | undefined; onSelect: (id: string) => void }) {
  // Layout depends on structure, not on the ticking clock; node data is refreshed separately.
  const structureKey = agents.map((a) => `${a.id}:${a.parentId ?? ''}:${estimateHeight(a)}`).join('|');
  const { nodes, edges } = useMemo(() => layout(agents, now, selectedAgentId, onSelect), [agents, now, selectedAgentId, onSelect]);
  return (
    <div className="topology" role="region" aria-label="Agent topology">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        <FitOnChange signature={structureKey} />
      </ReactFlow>
    </div>
  );
}
