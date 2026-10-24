// Collapsible task group and subgroup component (SPECIFICATION.md §2 T-02, PRD §3).
import type { Repository, Task } from '../../contracts/task.ts';
import type { TaskGroup, TaskSubgroup } from '../grouping.ts';
import { TaskRow } from './TaskRow.tsx';

interface TaskGroupViewProps {
  group: TaskGroup;
  repositories: Map<string, Repository>;
  selectedTaskId: string | null;
  collapsedKeys: Set<string>;
  onToggleCollapse: (key: string) => void;
  onSelectTask: (taskId: string) => void;
  onSelectParent: (parentId: string) => void;
}

export function TaskGroupView({
  group,
  repositories,
  selectedTaskId,
  collapsedKeys,
  onToggleCollapse,
  onSelectTask,
  onSelectParent,
}: TaskGroupViewProps) {
  const isGroupCollapsed = collapsedKeys.has(group.id);

  // Status-specific group icons
  const getGroupIcon = (value: string) => {
    switch (value) {
      case 'processing':
        return <span className="group-indicator group-indicator-processing">●</span>;
      case 'hitl':
        return <span className="group-indicator group-indicator-hitl">◉</span>;
      case 'todo':
        return <span className="group-indicator group-indicator-todo">○</span>;
      case 'done':
        return <span className="group-indicator group-indicator-done">✓</span>;
      case 'error':
        return <span className="group-indicator group-indicator-error">✕</span>;
      case 'cancelled':
        return <span className="group-indicator group-indicator-cancelled">—</span>;
      default:
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
        <span className="task-group-chevron">{isGroupCollapsed ? '›' : '⌄'}</span>
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
                  <span className="task-subgroup-chevron">{isSubCollapsed ? '›' : '⌄'}</span>
                  <span className="task-subgroup-label">{subgroup.label}</span>
                  <span className="task-subgroup-count">{subgroup.count}</span>
                </button>

                {!isSubCollapsed && (
                  <div className="task-subgroup-items">
                    {subgroup.tasks.map((task: Task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        repository={repositories.get(task.repoId)}
                        isSelected={task.id === selectedTaskId}
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
