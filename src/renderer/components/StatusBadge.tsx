import { Activity, AlertTriangle, CheckCircle2, PauseCircle } from 'lucide-react';
import type { AgentStatus } from '../../shared/types';

export const STATUS_LABEL: Record<AgentStatus, string> = { running: 'Running', idle: 'Idle', finished: 'Finished', errored: 'Errored' };

export const STATUS_ICON: Record<AgentStatus, typeof Activity> = { running: Activity, idle: PauseCircle, finished: CheckCircle2, errored: AlertTriangle };

export function StatusBadge({ status, compact = false }: { status: AgentStatus; compact?: boolean }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={`badge ${status}`} title={STATUS_LABEL[status]}>
      <Icon size={12} aria-hidden="true" />
      {compact ? <span className="sr-only">{STATUS_LABEL[status]}</span> : STATUS_LABEL[status]}
    </span>
  );
}
