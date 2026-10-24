// Task header pane component (SPECIFICATION.md §2 T-02, PRD §3).
import type { Repository, Task } from '../../contracts/task.ts';
import { PriorityBadge, StatusBadge } from './TaskBadges.tsx';

interface TaskHeaderProps {
  task: Task;
  repository?: Repository;
  parentTask?: Task;
  childTasks?: Task[];
  onSelectTask: (taskId: string) => void;
  onBack?: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onRetry: () => void;
  isActionLoading?: boolean;
}

export function TaskHeader({
  task,
  repository,
  parentTask,
  childTasks = [],
  onSelectTask,
  onBack,
  onEdit,
  onCancel,
  onRetry,
  isActionLoading = false,
}: TaskHeaderProps) {
  const repoName = repository ? repository.name : task.repoId;
  const canCancel = task.status === 'todo' || task.status === 'hitl' || task.status === 'error';
  const canRetry = task.status === 'error';
  const canEdit = task.status !== 'processing';

  return (
    <header className="task-header">
      <div className="task-header-main">
        <div className="task-header-title-row">
          {onBack && (
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-back-to-tasks"
              onClick={onBack}
              title="Back to tasks list"
              aria-label="Back to tasks list"
            >
              ← Tasks
            </button>
          )}
          <PriorityBadge priority={task.priority} />
          <span className="task-header-id">#{task.id}</span>
          <h1 className="task-header-title">{task.title}</h1>
        </div>

        <div className="task-header-actions-row">
          <StatusBadge status={task.status} />

          <div className="task-header-button-group">
            {canEdit && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onEdit}
                disabled={isActionLoading}
                title="Edit task title, description, or priority"
              >
                Edit
              </button>
            )}

            {canRetry && (
              <button
                type="button"
                className="btn btn-primary btn-sm btn-retry"
                onClick={onRetry}
                disabled={isActionLoading}
                title="Retry failed task"
              >
                Retry
              </button>
            )}

            {canCancel && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={onCancel}
                disabled={isActionLoading}
                title="Cancel task"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="task-header-meta-row">
        <span className="task-header-repo" title={repository?.canonicalPath ?? repoName}>
          <svg
            className="icon-repo"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.6-1.2-1.6 1.2a.25.25 0 0 1-.4-.2Z" />
          </svg>
          <span>{repoName}</span>
        </span>

        {task.parentId && (
          <button
            type="button"
            className="task-header-parent-link"
            onClick={() => {
              if (task.parentId) onSelectTask(task.parentId);
            }}
            title={`Go to parent task #${task.parentId}`}
          >
            ↳ Parent: #{task.parentId}
            {parentTask ? ` (${parentTask.title})` : ''}
          </button>
        )}
      </div>

      {task.blockedReason && (
        <div className="task-header-blocked-alert" role="alert">
          <span className="alert-icon">⚠️</span>
          <div className="alert-content">
            <strong>Blocked:</strong> {task.blockedReason}
            {task.blockedOnChildIds && task.blockedOnChildIds.length > 0 && (
              <span className="blocked-child-ids">
                {' '}
                (Waiting on children: {task.blockedOnChildIds.map((id) => `#${id}`).join(', ')})
              </span>
            )}
          </div>
        </div>
      )}

      {task.description && (
        <div className="task-header-description">
          <p>{task.description}</p>
        </div>
      )}

      {childTasks.length > 0 && (
        <div className="task-header-children">
          <span className="task-header-children-label">Child tasks ({childTasks.length}):</span>
          <div className="task-header-children-list">
            {childTasks.map((child) => (
              <button
                key={child.id}
                type="button"
                className="task-child-chip"
                onClick={() => onSelectTask(child.id)}
              >
                <PriorityBadge priority={child.priority} />
                <span className="chip-id">#{child.id}</span>
                <span className="chip-title">{child.title}</span>
                <span className={`chip-status chip-status-${child.status}`}>{child.status}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
