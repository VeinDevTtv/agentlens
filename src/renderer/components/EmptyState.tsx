import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon, title, children, actions }: { icon: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <Icon size={36} strokeWidth={1.5} aria-hidden="true" />
      <h2>{title}</h2>
      {children}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
