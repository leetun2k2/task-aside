import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../contracts/chat.ts';
import type {
  CreateRepositoryInput,
  CreateTaskInput,
  Repository,
  Task,
  UpdateTaskInput,
} from '../contracts/task.ts';
import {
  cancelTask,
  createRepository,
  createTask,
  fetchMessages,
  fetchRepositories,
  fetchTasks,
  getStoredAuthToken,
  postMessage,
  retryTask,
  updateTask,
} from './api.ts';
import { AvatarMenu } from './components/AvatarMenu.tsx';
import { CreateTaskModal } from './components/CreateTaskModal.tsx';
import { EditTaskModal } from './components/EditTaskModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import {
  type StreamingDelta,
  TaskConversation,
} from './components/TaskConversation.tsx';
import { TaskGroupView } from './components/TaskGroupView.tsx';
import { TaskHeader } from './components/TaskHeader.tsx';
import {
  type GroupMode,
  groupTasks,
  loadCollapsedPreference,
  loadGroupModePreference,
  saveCollapsedPreference,
  saveGroupModePreference,
} from './grouping.ts';

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [streamingDelta, setStreamingDelta] = useState<StreamingDelta | null>(null);
  const [isSendingMessage, setIsSendingMessage] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>(() => loadGroupModePreference());
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() =>
    loadCollapsedPreference(loadGroupModePreference()),
  );

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedTaskIdRef = useRef<string | null>(null);
  selectedTaskIdRef.current = selectedTaskId;

  // Load initial tasks and repositories
  const loadData = useCallback(async () => {
    try {
      setErrorMessage(null);
      const [fetchedTasks, fetchedRepos] = await Promise.all([fetchTasks(), fetchRepositories()]);
      setTasks(fetchedTasks);
      setRepositories(fetchedRepos);

      // Auto-select first task if none selected and tasks exist
      setSelectedTaskId((prev) => {
        if (prev && fetchedTasks.some((t) => t.id === prev)) {
          return prev;
        }
        return fetchedTasks[0]?.id ?? null;
      });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load data');
    }
  }, []);

  const loadMessages = useCallback(async (taskId: string) => {
    try {
      setIsLoadingMessages(true);
      const res = await fetchMessages(taskId);
      setMessages(res.messages);
    } catch (err: unknown) {
      console.error('Failed to load messages:', err);
    } finally {
      setIsLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load messages whenever selected task changes
  useEffect(() => {
    setStreamingDelta(null);
    if (selectedTaskId) {
      loadMessages(selectedTaskId);
    } else {
      setMessages([]);
    }
  }, [selectedTaskId, loadMessages]);

  // Connect to SSE stream for live updates and state reconciliation
  useEffect(() => {
    const token = getStoredAuthToken();
    const sseUrl = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        eventSource = new EventSource(sseUrl);

        // Connected handshake reconciles authoritative REST state
        eventSource.addEventListener('connected', () => {
          setStreamingDelta(null);
          loadData();
          if (selectedTaskIdRef.current) {
            loadMessages(selectedTaskIdRef.current);
          }
        });

        // Task status changed
        eventSource.addEventListener('task.status_changed', (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            setTasks((prev) =>
              prev.map((t) =>
                t.id === payload.taskId
                  ? {
                      ...t,
                      status: payload.status,
                      version: payload.version ?? t.version,
                      blockedReason: payload.blockedReason ?? t.blockedReason,
                      updatedAt: payload.updatedAt ?? t.updatedAt,
                    }
                  : t,
              ),
            );
          } catch {
            loadData();
          }
        });

        // Message delta (streaming)
        eventSource.addEventListener('message.delta', (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            setStreamingDelta((prev) => {
              if (prev && prev.messageId === payload.messageId) {
                return {
                  ...prev,
                  content: prev.content + (payload.delta ?? ''),
                };
              }
              return {
                runId: payload.runId ?? '',
                messageId: payload.messageId,
                content: payload.delta ?? '',
              };
            });
          } catch {
            // ignore
          }
        });

        // Message completed
        eventSource.addEventListener('message.completed', (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            setStreamingDelta(null);
            if (payload.taskId === selectedTaskIdRef.current) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === payload.messageId)) {
                  return prev.map((m) =>
                    m.id === payload.messageId ? { ...m, content: payload.content } : m,
                  );
                }
                const newMsg: Message = {
                  id: payload.messageId,
                  taskId: payload.taskId,
                  conversationId: payload.conversationId,
                  sender: payload.role ?? 'agent',
                  content: payload.content,
                  inReplyToRequestId: payload.inReplyToRequestId ?? null,
                  createdAt: payload.createdAt ?? new Date().toISOString(),
                };
                return [...prev, newMsg];
              });
            }
          } catch {
            if (selectedTaskIdRef.current) {
              loadMessages(selectedTaskIdRef.current);
            }
          }
        });

        // Input required (HITL)
        eventSource.addEventListener('input_required', (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            setStreamingDelta(null);
            setTasks((prev) =>
              prev.map((t) =>
                t.id === payload.taskId
                  ? { ...t, status: 'hitl', pendingInputRequestId: payload.requestId }
                  : t,
              ),
            );
            if (payload.taskId === selectedTaskIdRef.current) {
              loadMessages(payload.taskId);
            }
          } catch {
            loadData();
          }
        });

        // Run changed
        eventSource.addEventListener('run.changed', () => {
          loadData();
        });

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          // On disconnect/reconnect, transient deltas are discarded and authoritative state is fetched
          setStreamingDelta(null);
          reconnectTimeout = setTimeout(connect, 3000);
        };
      } catch {
        // Fallback polling if SSE cannot connect
        reconnectTimeout = setTimeout(connect, 5000);
      }
    };

    connect();

    return () => {
      if (eventSource) eventSource.close();
      clearTimeout(reconnectTimeout);
    };
  }, [loadData, loadMessages]);

  // Keyboard shortcut ⌘K / Ctrl+K for search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setIsCreateModalOpen(false);
        setIsEditModalOpen(false);
        setIsSettingsModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Filter tasks by search query
  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return tasks;
    const q = searchQuery.toLowerCase().trim();
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
    );
  }, [tasks, searchQuery]);

  // Group filtered tasks
  const taskGroups = useMemo(() => {
    return groupTasks(filteredTasks, groupMode);
  }, [filteredTasks, groupMode]);

  // Repositories map for fast lookup
  const repoMap = useMemo(() => {
    const map = new Map<string, Repository>();
    for (const repo of repositories) {
      map.set(repo.id, repo);
    }
    return map;
  }, [repositories]);

  // Currently selected task
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((t) => t.id === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  // Parent task of selected task
  const parentTask = useMemo(() => {
    if (!selectedTask?.parentId) return undefined;
    return tasks.find((t) => t.id === selectedTask.parentId);
  }, [tasks, selectedTask]);

  // Child tasks of selected task
  const childTasks = useMemo(() => {
    if (!selectedTask) return [];
    return tasks.filter((t) => t.parentId === selectedTask.id);
  }, [tasks, selectedTask]);

  // Handle group mode toggle
  const handleToggleGroupMode = (newMode: GroupMode) => {
    if (newMode === groupMode) return;
    setGroupMode(newMode);
    saveGroupModePreference(newMode);
    const savedCollapsed = loadCollapsedPreference(newMode);
    setCollapsedKeys(savedCollapsed);
  };

  // Handle group collapse toggle
  const handleToggleCollapse = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveCollapsedPreference(groupMode, next);
      return next;
    });
  };

  // Task actions
  const handleCreateTask = async (input: CreateTaskInput) => {
    const created = await createTask(input);
    setTasks((prev) => [created, ...prev]);
    setSelectedTaskId(created.id);
  };

  const handleEditTask = async (id: string, input: UpdateTaskInput) => {
    const updated = await updateTask(id, input);
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
  };

  const handleCancelTask = async () => {
    if (!selectedTask) return;
    try {
      setIsActionLoading(true);
      const cancelled = await cancelTask(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === selectedTask.id ? cancelled : t)));
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to cancel task');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRetryTask = async () => {
    if (!selectedTask) return;
    try {
      setIsActionLoading(true);
      const retried = await retryTask(selectedTask.id);
      setTasks((prev) => prev.map((t) => (t.id === selectedTask.id ? retried : t)));
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to retry task');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleAddRepository = async (repo: { name: string; displayPath: string }) => {
    const input: CreateRepositoryInput = {
      name: repo.name,
      displayPath: repo.displayPath,
      defaultProvider: 'codex',
    };
    const created = await createRepository(input);
    setRepositories((prev) => [...prev, created]);
  };

  const handleSendMessage = async (content: string, inReplyToRequestId?: string) => {
    if (!selectedTaskId) return;
    try {
      setIsSendingMessage(true);
      const newMsg = await postMessage(selectedTaskId, {
        content,
        inReplyToRequestId,
      });
      setMessages((prev) => [...prev, newMsg]);
      // If replying to HITL, task transitions to processing
      if (inReplyToRequestId) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === selectedTaskId
              ? { ...t, status: 'processing', pendingInputRequestId: null }
              : t,
          ),
        );
      }
    } finally {
      setIsSendingMessage(false);
    }
  };

  return (
    <div className={`app-container ${selectedTaskId ? 'has-selected-task' : ''}`}>
      {/* Left Sidebar: Task Inbox */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title-row">
            <h2 className="sidebar-title">Tasks</h2>
            <div className="sidebar-search-box">
              <input
                ref={searchInputRef}
                type="text"
                className="sidebar-search-input"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              ) : (
                <kbd className="search-shortcut">⌘K</kbd>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm btn-new-task"
              onClick={() => setIsCreateModalOpen(true)}
            >
              + New Task
            </button>
          </div>

          <div className="sidebar-group-controls">
            <span className="group-by-label">Group by</span>
            <div className="group-toggle-pills">
              <button
                type="button"
                className={`pill-btn ${groupMode === 'state-priority' ? 'pill-btn-active' : ''}`}
                onClick={() => handleToggleGroupMode('state-priority')}
              >
                State
              </button>
              <button
                type="button"
                className={`pill-btn ${groupMode === 'priority-state' ? 'pill-btn-active' : ''}`}
                onClick={() => handleToggleGroupMode('priority-state')}
              >
                Priority
              </button>
            </div>
            <span className="group-mode-subtext">
              {groupMode === 'state-priority' ? 'State → Priority' : 'Priority → State'}
            </span>
          </div>
        </div>

        {errorMessage && (
          <div className="sidebar-error-banner" role="alert">
            <span>{errorMessage}</span>
            <button
              type="button"
              className="banner-close-btn"
              onClick={() => setErrorMessage(null)}
            >
              ✕
            </button>
          </div>
        )}

        <div className="sidebar-task-list">
          {taskGroups.map((group) => (
            <TaskGroupView
              key={group.id}
              group={group}
              repositories={repoMap}
              selectedTaskId={selectedTaskId}
              collapsedKeys={collapsedKeys}
              onToggleCollapse={handleToggleCollapse}
              onSelectTask={setSelectedTaskId}
              onSelectParent={setSelectedTaskId}
            />
          ))}

          {tasks.length === 0 && (
            <div className="sidebar-empty-state">
              <p>No tasks yet.</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setIsCreateModalOpen(true)}
              >
                Create your first task
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <AvatarMenu onOpenSettings={() => setIsSettingsModalOpen(true)} userInitials="N" />
        </div>
      </aside>

      {/* Right Pane: Task Details */}
      <main className="main-content">
        {selectedTask ? (
          <div className="task-detail-pane">
            <TaskHeader
              task={selectedTask}
              repository={repoMap.get(selectedTask.repoId)}
              parentTask={parentTask}
              childTasks={childTasks}
              onSelectTask={setSelectedTaskId}
              onBack={() => setSelectedTaskId(null)}
              onEdit={() => setIsEditModalOpen(true)}
              onCancel={handleCancelTask}
              onRetry={handleRetryTask}
              isActionLoading={isActionLoading}
            />

            <TaskConversation
              task={selectedTask}
              messages={messages}
              isLoadingMessages={isLoadingMessages}
              streamingDelta={streamingDelta}
              onSendMessage={handleSendMessage}
              isSending={isSendingMessage}
            />
          </div>
        ) : (
          <div className="empty-selection-pane">
            <div className="empty-selection-content">
              <h2>Select a task</h2>
              <p>Choose a task from the sidebar to view details, or create a new one.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setIsCreateModalOpen(true)}
              >
                + New Task
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      <CreateTaskModal
        isOpen={isCreateModalOpen}
        repositories={repositories}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateTask}
        prefillParentId={selectedTask?.id}
      />

      <EditTaskModal
        task={selectedTask}
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        onSubmit={handleEditTask}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        repositories={repositories}
        onClose={() => setIsSettingsModalOpen(false)}
        onAddRepository={handleAddRepository}
      />
    </div>
  );
}
