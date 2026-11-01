// Task header pane component (SPECIFICATION.md §2 T-02, PRD §3).
import type { Repository, Task } from '../../contracts/task.ts';
import { PriorityBadge, StatusBadge } from './ui/Badge.tsx';
import { Button } from './ui/Button.tsx';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBan,
  IconCornerDownRight,
  IconGitBranch,
  IconPencil,
  IconRotateCw,
} from './ui/Icons.tsx';

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
  const repoName = repository ? repository.name : (task.repoId ?? 'Auto');
  const canCancel =
    task.status === 'todo' ||
    task.status === 'processing' ||
    task.status === 'hitl' ||
    task.status === 'error';
  const canRetry = task.status === 'error';
  const canEdit = task.status !== 'processing';

  return (
    <header className="task-header">
      <div className="task-header-main">
        <div className="task-header-title-row">
          {onBack && (
            <Button
              variant="secondary"
              size="sm"
              className="btn-back-to-tasks"
              onClick={onBack}
              title="Back to tasks list"
              aria-label="Back to tasks list"
            >
              <IconArrowLeft size={14} style={{ marginRight: '4px' }} />
              <span>Tasks</span>
            </Button>
          )}
          <PriorityBadge priority={task.priority} />
          <span className="task-header-id">#{task.id}</span>
          <h1 className="task-header-title" title={task.title}>
            {task.title}
          </h1>
        </div>

        <div className="task-header-actions-row">
          <StatusBadge status={task.status} />

          <div className="task-header-button-group">
            {canEdit && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onEdit}
                disabled={isActionLoading}
                title="Edit task title, description, or priority"
              >
                <IconPencil size={13} style={{ marginRight: '5px' }} />
                <span>Edit</span>
              </Button>
            )}

            {canRetry && (
              <Button
                variant="primary"
                size="sm"
                className="btn-retry"
                onClick={onRetry}
                disabled={isActionLoading}
                title="Retry failed task"
              >
                <IconRotateCw size={13} style={{ marginRight: '5px' }} />
                <span>Retry</span>
              </Button>
            )}

            {canCancel && (
              <Button
                variant="danger"
                size="sm"
                onClick={onCancel}
                disabled={isActionLoading}
                title="Cancel task"
              >
                <IconBan size={13} style={{ marginRight: '5px' }} />
                <span>Cancel</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="task-header-meta-row">
        <span
          className="task-header-repo"
          title={repository?.canonicalPath ?? repository?.displayPath ?? repoName}
        >
          <IconGitBranch size={14} className="icon-repo" />
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
            <IconCornerDownRight
              size={13}
              style={{ marginRight: '4px', verticalAlign: 'middle' }}
            />
            <span>Parent: #{task.parentId}</span>
            {parentTask ? ` (${parentTask.title})` : ''}
          </button>
        )}
      </div>

      {task.blockedReason && (
        <div className="task-header-blocked-alert" role="alert">
          <IconAlertTriangle size={16} className="alert-icon" />
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
