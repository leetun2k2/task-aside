// Single compact task item in the sidebar list (SPECIFICATION.md §2 T-02, PRD §3).
import type { Repository, Task } from '../../contracts/task.ts';
import { PriorityBadge, StatusBadge } from './TaskBadges.tsx';

interface TaskRowProps {
  task: Task;
  repository?: Repository;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  onSelectParent?: (parentId: string) => void;
}

export function TaskRow({ task, repository, isSelected, onSelect, onSelectParent }: TaskRowProps) {
  const repoName = repository ? repository.name : task.repoId;

  return (
    // biome-ignore lint/a11y/useSemanticElements: compound interactive row contains separate nested action button
    <div
      role="button"
      tabIndex={0}
      data-task-id={task.id}
      className={`task-row ${isSelected ? 'task-row-selected' : ''}`}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
    >
      <div className="task-row-top">
        <PriorityBadge priority={task.priority} />
        <span className="task-row-title" title={task.title}>
          {task.title}
        </span>
        <div className="task-row-status">
          <StatusBadge status={task.status} />
        </div>
      </div>

      <div className="task-row-bottom">
        <span className="task-row-repo" title={repository?.displayPath ?? repoName}>
          <svg
            className="icon-repo"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.6-1.2-1.6 1.2a.25.25 0 0 1-.4-.2Z" />
          </svg>
          {repoName}
        </span>

        {task.parentId && (
          <button
            type="button"
            className="task-row-parent"
            title={`Go to parent task #${task.parentId}`}
            onClick={(e) => {
              e.stopPropagation();
              if (onSelectParent && task.parentId) {
                onSelectParent(task.parentId);
              }
            }}
          >
            ↳ #{task.parentId}
          </button>
        )}

        {task.blockedReason && (
          <span className="task-row-blocked" title={`Blocked: ${task.blockedReason}`}>
            Blocked
          </span>
        )}
      </div>
    </div>
  );
}
