import type * as React from 'react';
import type { TaskPriority, TaskStatus } from '../../../contracts/task.ts';
import {
  IconStatusCancelled,
  IconStatusDone,
  IconStatusError,
  IconStatusHitl,
  IconStatusProcessing,
  IconStatusTodo,
} from './Icons.tsx';

export interface PriorityBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  priority: TaskPriority;
}

export function PriorityBadge({ priority, className = '', ...props }: PriorityBadgeProps) {
  return (
    <span
      className={`badge-priority badge-priority-${priority.toLowerCase()} ${className}`.trim()}
      {...props}
    >
      <span
        className={`priority-square priority-square-${priority.toLowerCase()}`}
        aria-hidden="true"
      />
      <span className="priority-label">{priority}</span>
    </span>
  );
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: TaskStatus;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  processing: 'Processing',
  hitl: 'Input Required',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
};

function renderStatusIcon(status: TaskStatus, size = 12) {
  switch (status) {
    case 'todo':
      return <IconStatusTodo size={size} />;
    case 'processing':
      return <IconStatusProcessing size={size} />;
    case 'hitl':
      return <IconStatusHitl size={size} />;
    case 'done':
      return <IconStatusDone size={size} />;
    case 'error':
      return <IconStatusError size={size} />;
    case 'cancelled':
      return <IconStatusCancelled size={size} />;
    default:
      return <IconStatusTodo size={size} />;
  }
}

export function StatusBadge({ status, className = '', ...props }: StatusBadgeProps) {
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`badge-status badge-status-${status} ${className}`.trim()} {...props}>
      <span className={`status-dot status-dot-${status}`} aria-hidden="true">
        {renderStatusIcon(status)}
      </span>
      <span className="status-label">{label}</span>
    </span>
  );
}

export function StatusIcon({
  status,
  size = 12,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { status: TaskStatus; size?: number }) {
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span
      className={`status-icon-indicator status-icon-indicator-${status} ${className}`.trim()}
      title={`Status: ${label}`}
      aria-label={`Status: ${label}`}
      {...props}
    >
      {renderStatusIcon(status, size)}
    </span>
  );
}
