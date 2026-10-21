import dagre from '@dagrejs/dagre';
import { Background, Controls, Handle, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Activity, AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, Circle, ExternalLink, FolderOpen, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatCost } from '../../core/pricing';
import { PERMISSION_LABEL } from '../../core/roles';
import type { RoleDefinition, StepStatus, WorkflowRun, WorkflowStatus, WorkflowStep } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { formatDuration, formatRelative } from '../lib/format';
import { useStore } from '../store';

const NODE_WIDTH = 300;

const STEP_LABEL: Record<StepStatus, string> = { pending: 'Pending', running: 'Running', finished: 'Finished', errored: 'Errored', cancelled: 'Cancelled' };
const STEP_ICON: Record<StepStatus, typeof Activity> = { pending: Circle, running: Activity, finished: CheckCircle2, errored: AlertTriangle, cancelled: Ban };
const WORKFLOW_LABEL: Record<WorkflowStatus, string> = { running: 'Running', finished: 'Finished', errored: 'Errored', cancelled: 'Cancelled' };
const WORKFLOW_ICON: Record<WorkflowStatus, typeof Activity> = { running: Activity, finished: CheckCircle2, errored: AlertTriangle, cancelled: Ban };
/** Map step and workflow statuses onto the existing badge colour classes. */
const BADGE_CLASS: Record<StepStatus | WorkflowStatus, string> = { pending: 'pending', running: 'running', finished: 'finished', errored: 'errored', cancelled: 'idle' };

function StepBadge({ status }: { status: StepStatus }) {
  const Icon = STEP_ICON[status];
  return (
    <span className={`badge ${BADGE_CLASS[status]}`} title={STEP_LABEL[status]}>
      <Icon size={12} aria-hidden="true" />
      {STEP_LABEL[status]}
    </span>
  );
}

function WorkflowBadge({ status }: { status: WorkflowStatus }) {
  const Icon = WORKFLOW_ICON[status];
  return (
    <span className={`badge ${BADGE_CLASS[status]}`} title={WORKFLOW_LABEL[status]}>
      <Icon size={12} aria-hidden="true" />
      {WORKFLOW_LABEL[status]}
    </span>
  );
}

function excerpt(text: string | undefined, max = 280): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

type StepNodeData = { step: WorkflowStep; index: number; role: RoleDefinition | undefined; now: number; runExists: boolean; onOpenRun: (sessionId: string) => void };
type StepNode = Node<StepNodeData, 'step'>;

function estimateHeight(step: WorkflowStep): number {
  let height = 120;
  if (step.status === 'running' && step.currentAction) height += 22;
  if (step.status === 'running' && step.liveText) height += 70;
  if (step.status === 'finished' && step.output) height += 70;
  if (step.status === 'errored' && step.error) height += 44;
  return height;
}

function StepNodeView({ data }: NodeProps<StepNode>) {
  const { step, index, role, now, runExists, onOpenRun } = data;
  const end = step.endedAt ?? (step.status === 'running' ? now : undefined);
  const elapsed = formatDuration(step.startedAt, end);
  return (
    <div className="wf-node-wrap">
      <Handle type="target" position={Position.Left} isConnectable={false} className="agent-handle" />
      <div className={`wf-node agent-card ${step.status}`} aria-label={`Step ${index + 1}: ${role?.name ?? step.roleId}. ${STEP_LABEL[step.status]}.`}>
        <div className="top">
          <span className="role">Step {index + 1}</span>
          <StepBadge status={step.status} />
        </div>
        <div className="title">
          {role?.name ?? step.roleId}
          {role && <span className={`badge type perm-${role.permission}`}>{PERMISSION_LABEL[role.permission]}</span>}
        </div>
        {role?.description && <div className="subtitle">{role.description}</div>}
        {step.status === 'running' && step.currentAction && (
          <div className="line">
            <span className="label">Now</span>
            <span className="value">{step.currentAction}</span>
          </div>
        )}
        {step.status === 'running' && step.liveText && <div className="wf-live">{step.liveText}</div>}
        {step.status === 'finished' && step.output && <div className="wf-live">{excerpt(step.output)}</div>}
        {step.status === 'errored' && step.error && (
          <div className="line error">
            <span className="label">Error</span>
            <span className="value" title={step.error}>
              {excerpt(step.error, 160)}
            </span>
          </div>
        )}
        <div className="foot">
          {elapsed && <span title="Elapsed">{elapsed}</span>}
          {step.turns !== undefined && <span title="Turns">{step.turns} turns</span>}
          {step.costUsd !== undefined && <span title="Reported cost">{formatCost(step.costUsd)}</span>}
          <button
            type="button"
            className="btn small wf-open"
            disabled={!runExists}
            title={runExists ? 'Open this step as a run' : 'Session log not found yet'}
            onClick={() => runExists && onOpenRun(step.sessionId)}
          >
            <ExternalLink size={12} aria-hidden="true" /> Open run
          </button>
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="agent-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { step: StepNodeView };

const EDGE_COLOR: Record<StepStatus, string> = {
  pending: 'var(--border-strong)',
  running: 'var(--running)',
  finished: 'var(--finished)',
  errored: 'var(--errored)',
  cancelled: 'var(--idle)',
};

function layout(workflow: WorkflowRun, roles: RoleDefinition[], now: number, runIds: Set<string>, onOpenRun: (sessionId: string) => void): { nodes: StepNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 70, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const step of workflow.steps) graph.setNode(step.id, { width: NODE_WIDTH, height: estimateHeight(step) });
  const edges: Edge[] = [];
  workflow.steps.forEach((step, index) => {
    const previous = workflow.steps[index - 1];
    if (!previous) return;
    graph.setEdge(previous.id, step.id);
    edges.push({
      id: `${previous.id}->${step.id}`,
      source: previous.id,
      target: step.id,
      type: 'smoothstep',
      animated: step.status === 'running',
      style: { stroke: EDGE_COLOR[step.status], strokeWidth: step.status === 'running' ? 2.2 : 1.6, opacity: step.status === 'pending' ? 0.6 : 1 },
      ariaLabel: `${previous.roleId} hands off to ${step.roleId}`,
    });
  });
  dagre.layout(graph);
  const nodes: StepNode[] = workflow.steps.map((step, index) => {
    const pos = graph.node(step.id);
    return {
      id: step.id,
      type: 'step',
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - pos.height / 2 },
      data: { step, index, role: roles.find((r) => r.id === step.roleId), now, runExists: runIds.has(step.sessionId), onOpenRun },
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

export function WorkflowView({ workflow }: { workflow: WorkflowRun }) {
  const roles = useStore((s) => s.orchestrator?.roles ?? []);
  const runs = useStore((s) => s.snapshot?.runs);
  const now = useStore((s) => s.now);
  const selectRun = useStore((s) => s.selectRun);
  const removeWorkflow = useStore((s) => s.removeWorkflow);
  const upsertWorkflow = useStore((s) => s.upsertWorkflow);
  const [outputsOpen, setOutputsOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const runIds = useMemo(() => new Set((runs ?? []).map((r) => r.id)), [runs]);
  const structureKey = workflow.steps.map((s) => `${s.id}:${estimateHeight(s)}`).join('|');
  const { nodes, edges } = useMemo(() => layout(workflow, roles, now, runIds, selectRun), [workflow, roles, now, runIds, selectRun]);

  const finishedSteps = workflow.steps.filter((s) => s.status === 'finished' && s.output);
  const done = workflow.steps.filter((s) => s.status === 'finished').length;
  const totalCost = workflow.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
  const end = workflow.status === 'running' ? now : workflow.updatedAt;

  const cancel = async () => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      const updated = await api.cancelWorkflow(workflow.id);
      if (updated) upsertWorkflow(updated);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const api = bridge();
    if (!api) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"? Session logs are kept.`)) return;
    setBusy(true);
    try {
      await api.deleteWorkflow(workflow.id);
      removeWorkflow(workflow.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-view" role="region" aria-label="Workflow">
      <div className="wf-header">
        <div className="wf-heading">
          <div className="wf-name">
            {workflow.name}
            <WorkflowBadge status={workflow.status} />
          </div>
          <div className="wf-goal" title={workflow.goal}>
            {workflow.goal}
          </div>
          <div className="wf-meta">
            <span className="mono" title="Working directory">
              <FolderOpen size={11} aria-hidden="true" /> {workflow.cwd}
            </span>
            <span>
              Steps <b>{done}/{workflow.steps.length}</b>
            </span>
            <span>
              Elapsed <b>{formatDuration(workflow.createdAt, end) || '–'}</b>
            </span>
            {totalCost > 0 && (
              <span>
                Cost <b>{formatCost(totalCost)}</b>
              </span>
            )}
            <span>Updated {formatRelative(workflow.updatedAt, now)}</span>
          </div>
          {workflow.error && workflow.status === 'errored' && <p className="error-text small wf-error">{workflow.error}</p>}
        </div>
        <div className="wf-actions">
          {workflow.status === 'running' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void cancel()}>
              <Square size={13} aria-hidden="true" /> Cancel
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void remove()} title="Delete this workflow record">
            <Trash2 size={13} aria-hidden="true" /> Delete
          </button>
        </div>
      </div>
      <div className="wf-graph">
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
      <section className="wf-outputs">
        <button type="button" className="wf-outputs-toggle" onClick={() => setOutputsOpen((o) => !o)} aria-expanded={outputsOpen}>
          {outputsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          Outputs
          <span className="count">{finishedSteps.length}</span>
        </button>
        {outputsOpen && (
          <div className="wf-outputs-body">
            {finishedSteps.length === 0 && <p className="muted small">No step has finished yet.</p>}
            {finishedSteps.map((step, index) => {
              const role = roles.find((r) => r.id === step.roleId);
              return (
                <div key={step.id} className="wf-output-block">
                  <h3>
                    {workflow.steps.indexOf(step) + 1}. {role?.name ?? step.roleId}
                  </h3>
                  <pre className="wf-output">{step.output}</pre>
                  {index < finishedSteps.length - 1 && <hr />}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
