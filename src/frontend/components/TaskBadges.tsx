// Reusable badge components for Task priorities and statuses.
import type { TaskPriority, TaskStatus } from '../../contracts/task.ts';

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`badge-priority badge-priority-${priority.toLowerCase()}`}>{priority}</span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const getStatusContent = () => {
    switch (status) {
      case 'processing':
        return {
          label: 'Processing',
          dotClass: 'status-dot-processing',
          icon: '●',
        };
      case 'hitl':
        return {
          label: 'Input Required',
          dotClass: 'status-dot-hitl',
          icon: '●',
        };
      case 'todo':
        return {
          label: 'Todo',
          dotClass: 'status-dot-todo',
          icon: '○',
        };
      case 'done':
        return {
          label: 'Done',
          dotClass: 'status-dot-done',
          icon: '✓',
        };
      case 'error':
        return {
          label: 'Error',
          dotClass: 'status-dot-error',
          icon: '✕',
        };
      case 'cancelled':
        return {
          label: 'Cancelled',
          dotClass: 'status-dot-cancelled',
          icon: '—',
        };
    }
  };

  const { label, dotClass, icon } = getStatusContent();

  return (
    <span className={`badge-status badge-status-${status}`}>
      <span className={`status-dot ${dotClass}`}>{icon}</span>
      <span className="status-label">{label}</span>
    </span>
  );
}
