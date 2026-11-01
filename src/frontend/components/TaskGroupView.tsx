// Collapsible task group and subgroup component (SPECIFICATION.md §2 T-02, PRD §3).
import type { Repository, Task } from '../../contracts/task.ts';
import type { GroupMode, TaskGroup, TaskSubgroup } from '../grouping.ts';
import { TaskRow } from './TaskRow.tsx';
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconStatusCancelled,
  IconStatusDone,
  IconStatusError,
  IconStatusHitl,
  IconStatusProcessing,
  IconStatusTodo,
} from './ui/Icons.tsx';

interface TaskGroupViewProps {
  group: TaskGroup;
  repositories: Map<string, Repository>;
  selectedTaskId: string | null;
  collapsedKeys: Set<string>;
  groupMode?: GroupMode;
  onToggleCollapse: (key: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectParent: (parentId: string) => void;
}

export function TaskGroupView({
  group,
  repositories,
  selectedTaskId,
  collapsedKeys,
  groupMode,
  onToggleCollapse,
  onSelectTask,
  onSelectParent,
}: TaskGroupViewProps) {
  const isGroupCollapsed = collapsedKeys.has(group.id);

  // Status-specific group icons
  const getGroupIcon = (value: string) => {
    switch (value) {
      case 'processing':
        return (
          <span className="group-indicator group-indicator-processing">
            <IconStatusProcessing size={13} />
          </span>
        );
      case 'hitl':
        return (
          <span className="group-indicator group-indicator-hitl">
            <IconStatusHitl size={13} />
          </span>
        );
      case 'todo':
        return (
          <span className="group-indicator group-indicator-todo">
            <IconStatusTodo size={13} />
          </span>
        );
      case 'done':
        return (
          <span className="group-indicator group-indicator-done">
            <IconStatusDone size={13} />
          </span>
        );
      case 'error':
        return (
          <span className="group-indicator group-indicator-error">
            <IconStatusError size={13} />
          </span>
        );
      case 'cancelled':
        return (
          <span className="group-indicator group-indicator-cancelled">
            <IconStatusCancelled size={13} />
          </span>
        );
      case 'P0':
      case 'P1':
      case 'P2':
      case 'P3':
        return (
          <span
            className={`priority-square priority-square-${value.toLowerCase()} priority-square-group`}
            aria-hidden="true"
          />
        );
      default:
        if (group.id.startsWith('repo-') || value.startsWith('repo-')) {
          return (
            <span className="group-indicator group-indicator-repo">
              <IconGitBranch size={13} />
            </span>
          );
        }
        return null;
    }
  };

  return (
    <div className={`task-group ${isGroupCollapsed ? 'task-group-collapsed' : ''}`}>
      <button
        type="button"
        className="task-group-header"
        onClick={() => onToggleCollapse(group.id)}
        aria-expanded={!isGroupCollapsed}
      >
        <span className="task-group-chevron">
          {isGroupCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
        </span>
        {getGroupIcon(group.value)}
        <span className="task-group-label">{group.label}</span>
        <span className="task-group-count">{group.count}</span>
      </button>

      {!isGroupCollapsed && (
        <div className="task-group-content">
          {group.subgroups.map((subgroup: TaskSubgroup) => {
            // Only render subgroups that have tasks, or render all if needed
            if (subgroup.count === 0) return null;

            const isSubCollapsed = collapsedKeys.has(subgroup.id);

            return (
              <div
                key={subgroup.id}
                className={`task-subgroup ${isSubCollapsed ? 'task-subgroup-collapsed' : ''}`}
              >
                <button
                  type="button"
                  className="task-subgroup-header"
                  onClick={() => onToggleCollapse(subgroup.id)}
                  aria-expanded={!isSubCollapsed}
                >
                  <span className="task-subgroup-chevron">
                    {isSubCollapsed ? (
                      <IconChevronRight size={11} />
                    ) : (
                      <IconChevronDown size={11} />
                    )}
                  </span>
                  {getGroupIcon(subgroup.value)}
                  <span className="task-subgroup-label">{subgroup.label}</span>
                  <span className="task-subgroup-count">{subgroup.count}</span>
                </button>

                {!isSubCollapsed && (
                  <div className="task-subgroup-items">
                    {subgroup.tasks.map((task: Task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repository={task.repoId ? repositories.get(task.repoId) : undefined}
                        isSelected={task.id === selectedTaskId}
                        groupMode={groupMode}
                        onSelect={onSelectTask}
                        onSelectParent={onSelectParent}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
