import type * as React from 'react';
import type { TaskPriority, TaskStatus } from '../../../contracts/task.ts';

export interface PriorityBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  priority: TaskPriority;
}

export function PriorityBadge({ priority, className = '', ...props }: PriorityBadgeProps) {
  return (
    <span
      className={`badge-priority badge-priority-${priority.toLowerCase()} ${className}`.trim()}
      {...props}
    >
      {priority}
    </span>
  );
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: TaskStatus;
}

const STATUS_META: Record<TaskStatus, { label: string; icon: string }> = {
  todo: { label: 'Todo', icon: '○' },
  processing: { label: 'Processing', icon: '●' },
  hitl: { label: 'Input Required', icon: '●' },
  done: { label: 'Done', icon: '✓' },
  error: { label: 'Error', icon: '✕' },
  cancelled: { label: 'Cancelled', icon: '—' },
};

export function StatusBadge({ status, className = '', ...props }: StatusBadgeProps) {
  const meta = STATUS_META[status] ?? { label: status, icon: '•' };
  return (
    <span className={`badge-status badge-status-${status} ${className}`.trim()} {...props}>
      <span className={`status-dot status-dot-${status}`} aria-hidden="true">
        {meta.icon}
      </span>
      <span className="status-label">{meta.label}</span>
    </span>
  );
}
