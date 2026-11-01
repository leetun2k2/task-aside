import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repository, Task } from '../../contracts/task.ts';
import { PriorityBadge, StatusBadge } from './TaskBadges.tsx';
import { IconGitBranch, IconSearch, IconX } from './ui/Icons.tsx';

export interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  repositories: Repository[];
  onSelectTask: (taskId: string) => void;
}

export function CommandPaletteModal({
  isOpen,
  onClose,
  tasks,
  repositories,
  onSelectTask,
}: CommandPaletteModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Map of repoId -> Repository
  const repoMap = useMemo(() => {
    const map = new Map<string, Repository>();
    for (const r of repositories) {
      map.set(r.id, r);
    }
    return map;
  }, [repositories]);

  // Filter tasks based on query
  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return tasks.slice(0, 25);
    }
    return tasks.filter((task) => {
      const titleMatch = task.title.toLowerCase().includes(q);
      const idMatch = task.id.toLowerCase().includes(q);
      const statusMatch = task.status.toLowerCase().includes(q);
      const priorityMatch = task.priority.toLowerCase().includes(q);
      const descMatch = task.description?.toLowerCase().includes(q) ?? false;
      const repoName = (task.repoId ? repoMap.get(task.repoId)?.name : undefined)?.toLowerCase() ?? '';
      const repoMatch = repoName.includes(q) || (task.repoId?.toLowerCase().includes(q) ?? false);

      return titleMatch || idMatch || statusMatch || priorityMatch || descMatch || repoMatch;
    });
  }, [tasks, query, repoMap]);

  // Reset query and selectedIndex when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Keep selected index within bounds
  useEffect(() => {
    if (selectedIndex >= filteredTasks.length) {
      setSelectedIndex(Math.max(0, filteredTasks.length - 1));
    }
  }, [filteredTasks.length, selectedIndex]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedElement = listRef.current.querySelector(
      `[data-index="${selectedIndex}"]`,
    ) as HTMLElement | null;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < filteredTasks.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredTasks.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = filteredTasks[selectedIndex];
      if (current) {
        onSelectTask(current.id);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss handled by Escape and click
    <div
      className="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <dialog
        open
        className="command-palette-dialog"
        aria-label="Command Palette"
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette-search-bar">
          <IconSearch size={18} className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Search tasks by title, ID, status, priority, repository..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          {query ? (
            <button
              type="button"
              className="command-palette-clear-btn"
              onClick={() => {
                setQuery('');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              aria-label="Clear query"
            >
              <IconX size={14} />
            </button>
          ) : (
            <kbd className="command-palette-kbd">ESC</kbd>
          )}
        </div>

        <div className="command-palette-results" ref={listRef}>
          {filteredTasks.length > 0 ? (
            filteredTasks.map((task, index) => {
              const isSelected = index === selectedIndex;
              const repo = task.repoId ? repoMap.get(task.repoId) : undefined;
              const repoName = repo ? repo.name : (task.repoId ?? 'Auto');

              return (
                <button
                  type="button"
                  key={task.id}
                  data-index={index}
                  className={`command-palette-item ${isSelected ? 'command-palette-item-selected' : ''}`}
                  onClick={() => {
                    onSelectTask(task.id);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="command-palette-item-leading">
                    <PriorityBadge priority={task.priority} />
                  </span>

                  <span className="command-palette-item-main">
                    <span className="command-palette-item-title-row">
                      <span className="command-palette-item-title">{task.title}</span>
                      {task.parentId && (
                        <span className="command-palette-item-parent">↳ Subtask</span>
                      )}
                    </span>
                    <span className="command-palette-item-meta">
                      <span className="command-palette-item-repo">
                        <IconGitBranch size={12} />
                        <span>{repoName}</span>
                      </span>
                      <span className="command-palette-item-id">#{task.id.slice(0, 8)}</span>
                    </span>
                  </span>

                  <span className="command-palette-item-trailing">
                    <StatusBadge status={task.status} />
                  </span>
                </button>
              );
            })
          ) : (
            <div className="command-palette-empty">
              <IconSearch size={24} className="command-palette-empty-icon" />
              <p className="command-palette-empty-title">No tasks found</p>
              <p className="command-palette-empty-sub">
                No tasks match &ldquo;{query}&rdquo;. Try another keyword.
              </p>
            </div>
          )}
        </div>

        <div className="command-palette-footer">
          <div className="command-palette-hints">
            <span className="command-palette-hint">
              <kbd className="command-palette-key">↑</kbd>
              <kbd className="command-palette-key">↓</kbd>
              <span>Navigate</span>
            </span>
            <span className="command-palette-hint">
              <kbd className="command-palette-key">↵</kbd>
              <span>Select</span>
            </span>
            <span className="command-palette-hint">
              <kbd className="command-palette-key">ESC</kbd>
              <span>Close</span>
            </span>
          </div>
          <span className="command-palette-count">
            {filteredTasks.length} {filteredTasks.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
      </dialog>
    </div>
  );
}
