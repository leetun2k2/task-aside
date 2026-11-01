// Single compact task item in the sidebar list (SPECIFICATION.md §2 T-02, PRD §3).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Repository, Task } from '../../contracts/task.ts';
import type { GroupMode } from '../grouping.ts';
import { PriorityBadge, StatusBadge, StatusIcon } from './TaskBadges.tsx';
import {
  IconAlertTriangle,
  IconCornerDownRight,
  IconGitBranch,
  IconMoreVertical,
} from './ui/Icons.tsx';

interface TaskRowProps {
  task: Task;
  repository?: Repository;
  isSelected: boolean;
  groupMode?: GroupMode;
  onSelect: (taskId: string) => void;
  onSelectParent?: (parentId: string) => void;
}

export function TaskRow({
  task,
  repository,
  isSelected,
  groupMode = 'state-priority',
  onSelect,
  onSelectParent,
}: TaskRowProps) {
  const repoName = repository ? repository.name : (task.repoId ?? 'Auto');
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setIsPopoverOpen(false);
    }, 140);
  };

  const handleOpenPopover = () => {
    clearCloseTimer();
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverWidth = 300;
      const left =
        rect.right + 8 + popoverWidth > window.innerWidth
          ? Math.max(10, rect.left - popoverWidth - 8)
          : rect.right + 8;
      const top = Math.max(12, Math.min(window.innerHeight - 300, rect.top - 20));
      setPopoverPos({ top, left });
      setIsPopoverOpen(true);
    }
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useSemanticElements: compound interactive row contains separate nested action button
    <div
      role="button"
      tabIndex={0}
      data-task-id={task.id}
      aria-selected={isSelected}
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
        {/* Label remaining groups delicately: Priority if not grouped by priority, State if not grouped by state */}
        {groupMode !== 'priority-state' && <PriorityBadge priority={task.priority} />}
        {groupMode !== 'state-priority' && <StatusIcon status={task.status} />}

        <span className="task-row-title" title={task.title}>
          {task.title}
        </span>

        {/* 3-dots menu button with hover brief popover */}
        <div className="task-row-more-container">
          <button
            ref={moreBtnRef}
            type="button"
            className="task-row-more-btn"
            title="View task brief"
            aria-label={`Task ${task.title} options`}
            onClick={(e) => {
              e.stopPropagation();
              handleOpenPopover();
            }}
            onMouseEnter={handleOpenPopover}
            onMouseLeave={scheduleClose}
          >
            <IconMoreVertical size={14} />
          </button>
        </div>
      </div>

      {/* Subtask or Blocked alerts (repo is not labeled on every row to keep sidebar clean) */}
      {(task.parentId || task.blockedReason) && (
        <div className="task-row-bottom">
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
              <IconCornerDownRight size={11} />
              <span>#{task.parentId.slice(0, 8)}</span>
            </button>
          )}

          {task.blockedReason && (
            <span className="task-row-blocked" title={`Blocked: ${task.blockedReason}`}>
              <IconAlertTriangle size={11} />
              <span>Blocked</span>
            </span>
          )}
        </div>
      )}

      {/* Floating brief popover rendered to document body */}
      {isPopoverOpen &&
        popoverPos &&
        createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: popover click stop-propagation container
          <div
            className="task-brief-popover"
            style={{
              position: 'fixed',
              top: `${popoverPos.top}px`,
              left: `${popoverPos.left}px`,
            }}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
            role="tooltip"
          >
            <div className="task-popover-header">
              <span className="task-popover-id">#{task.id.slice(0, 8)}</span>
              <div className="task-popover-badges">
                <PriorityBadge priority={task.priority} />
                <StatusBadge status={task.status} />
              </div>
            </div>

            <h4 className="task-popover-title">{task.title}</h4>

            <div className="task-popover-grid">
              <div className="task-popover-row">
                <span className="task-popover-label">Repository:</span>
                <span className="task-popover-value">
                  <IconGitBranch size={12} className="task-popover-repo-icon" />
                  <span>{repoName}</span>
                </span>
              </div>
              {repository?.displayPath && (
                <div className="task-popover-path" title={repository.displayPath}>
                  {repository.displayPath}
                </div>
              )}

              {task.parentId && (
                <div className="task-popover-row">
                  <span className="task-popover-label">Parent Task:</span>
                  <span className="task-popover-value">#{task.parentId.slice(0, 8)}</span>
                </div>
              )}

              {task.blockedReason && (
                <div className="task-popover-blocked-alert">
                  <IconAlertTriangle size={12} />
                  <span>Blocked: {task.blockedReason}</span>
                </div>
              )}

              {task.description && (
                <div className="task-popover-desc">
                  <span className="task-popover-label">Description:</span>
                  <p className="task-popover-desc-text">{task.description}</p>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
