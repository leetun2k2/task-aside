import {
  type InfiniteData,
  type QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserInputRequiredSchema,
  BrowserMessageCompletedSchema,
  BrowserMessageDeltaSchema,
  BrowserTaskStatusChangedSchema,
} from '../contracts/browser-events.ts';
import type { Message } from '../contracts/chat.ts';
import type {
  CreateRepositoryInput,
  CreateTaskInput,
  Repository,
  Task,
  UpdateTaskInput,
} from '../contracts/task.ts';
import {
  type MessagesResponse,
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
import { type StreamingDelta, TaskConversation } from './components/TaskConversation.tsx';
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
import { createQueryClient, queryKeys } from './queries.ts';

const defaultQueryClient = createQueryClient();

export function AppContent() {
  const queryClient = useQueryClient();

  const {
    data: tasks = [],
    isLoading: isTasksLoading,
    error: tasksError,
    refetch: refetchTasks,
  } = useQuery({
    queryKey: queryKeys.tasks(),
    queryFn: ({ signal }) => fetchTasks({}, { signal }),
  });

  const {
    data: repositories = [],
    isLoading: isReposLoading,
    error: reposError,
    refetch: refetchRepositories,
  } = useQuery({
    queryKey: queryKeys.repositories,
    queryFn: ({ signal }) => fetchRepositories({ signal }),
  });

  const setTasks = useCallback(
    (updater: Task[] | ((prev: Task[]) => Task[])) => {
      queryClient.setQueryData<Task[]>(queryKeys.tasks(), (old = []) => {
        return typeof updater === 'function' ? updater(old) : updater;
      });
    },
    [queryClient],
  );

  const setRepositories = useCallback(
    (updater: Repository[] | ((prev: Repository[]) => Repository[])) => {
      queryClient.setQueryData<Repository[]>(queryKeys.repositories, (old = []) => {
        return typeof updater === 'function' ? updater(old) : updater;
      });
    },
    [queryClient],
  );

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const {
    data: messagesPages,
    isLoading: isLoadingMessages,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.messages(selectedTaskId ?? ''),
    queryFn: ({ pageParam, signal }) => {
      if (!selectedTaskId) return Promise.resolve({ messages: [], nextCursor: null });
      return fetchMessages(selectedTaskId, { cursor: pageParam ?? undefined }, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!selectedTaskId,
    staleTime: 5000,
  });

  const messages = useMemo(() => {
    if (!messagesPages?.pages) return [];
    const seen = new Set<string>();
    const result: Message[] = [];
    for (const page of messagesPages.pages) {
      for (const msg of page.messages) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          result.push(msg);
        }
      }
    }
    return result;
  }, [messagesPages]);

  const setTaskMessages = useCallback(
    (taskId: string, updater: (prev: Message[]) => Message[]) => {
      queryClient.setQueryData<InfiniteData<MessagesResponse>>(
        queryKeys.messages(taskId),
        (old) => {
          if (!old || old.pages.length === 0) {
            return {
              pages: [{ messages: updater([]), nextCursor: null }],
              pageParams: [null],
            };
          }
          const allMessages = old.pages.flatMap((p) => p.messages);
          const updatedAll = updater(allMessages);
          const lastPageIndex = old.pages.length - 1;
          const newPages = old.pages.map((page, idx) => {
            if (idx === lastPageIndex) {
              const existingIds = new Set(
                old.pages.slice(0, lastPageIndex).flatMap((p) => p.messages.map((m) => m.id)),
              );
              const lastPageMsgs = updatedAll.filter((m) => !existingIds.has(m.id));
              return {
                ...page,
                messages: lastPageMsgs,
              };
            }
            return page;
          });
          return {
            ...old,
            pages: newPages,
          };
        },
      );
    },
    [queryClient],
  );

  const [streamingDeltasByTask, setStreamingDeltasByTask] = useState<
    Record<string, StreamingDelta>
  >({});
  const [sendingTaskIds, setSendingTaskIds] = useState<Set<string>>(() => new Set());
  const [draftsByTask, setDraftsByTask] = useState<Record<string, string>>({});

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

  // Auto-select first task if none selected or restore selection
  useEffect(() => {
    if (tasks.length > 0) {
      setSelectedTaskId((prev) => {
        if (prev && tasks.some((t) => t.id === prev)) {
          return prev;
        }
        return tasks[0].id;
      });
    }
  }, [tasks]);

  // Load initial tasks and repositories
  const loadData = useCallback(async () => {
    try {
      setErrorMessage(null);
      await Promise.all([refetchTasks(), refetchRepositories()]);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load data');
    }
  }, [refetchTasks, refetchRepositories]);

  // Connect to SSE stream for live updates and state reconciliation
  useEffect(() => {
    const token = getStoredAuthToken();
    const sseUrl = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let reconnectAttempts = 0;
    const deltaBuffer: Record<string, StreamingDelta> = {};
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushDeltaBuffer = () => {
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      const bufferedKeys = Object.keys(deltaBuffer);
      if (bufferedKeys.length === 0) return;

      setStreamingDeltasByTask((prev) => {
        const next = { ...prev };
        for (const taskId of bufferedKeys) {
          const buffered = deltaBuffer[taskId];
          if (!buffered) continue;
          const current = next[taskId];
          if (
            current &&
            current.messageId === buffered.messageId &&
            current.runId === buffered.runId
          ) {
            next[taskId] = {
              ...current,
              content: current.content + buffered.content,
            };
          } else {
            next[taskId] = { ...buffered };
          }
          delete deltaBuffer[taskId];
        }
        return next;
      });
    };

    const connect = () => {
      try {
        eventSource = new EventSource(sseUrl);

        // Connected handshake reconciles authoritative REST state
        eventSource.addEventListener('connected', () => {
          reconnectAttempts = 0;
          if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
          setStreamingDeltasByTask({});
          loadData();
          if (selectedTaskIdRef.current) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.messages(selectedTaskIdRef.current),
            });
          }
        });

        // Task status changed - with version monotonicity, null clearing, and cache gap invalidation
        eventSource.addEventListener('task.status_changed', (e: MessageEvent) => {
          try {
            const raw = JSON.parse(e.data);
            const parsed = BrowserTaskStatusChangedSchema.safeParse(raw);
            const payload = parsed.success ? parsed.data : raw;
            setTasks((prev) => {
              const existing = prev.find((t) => t.id === payload.taskId);
              if (!existing) {
                // Missing row in cache: invalidate tasks to reveal newly created task
                queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
                return prev;
              }
              // Monotonic version protection: never roll version backward
              if (payload.version !== undefined && payload.version < existing.version) {
                return prev;
              }
              return prev.map((t) =>
                t.id === payload.taskId
                  ? {
                      ...t,
                      status: payload.status,
                      version: payload.version ?? t.version,
                      // Explicit null clearing: null must explicitly clear blocked status
                      blockedReason:
                        'blockedReason' in payload ? payload.blockedReason : t.blockedReason,
                      blockKind: 'blockKind' in payload ? payload.blockKind : t.blockKind,
                      updatedAt: payload.updatedAt ?? t.updatedAt,
                    }
                  : t,
              );
            });
          } catch {
            loadData();
          }
        });

        // Message delta (streaming) - bounded 50ms batching strictly isolated by task and run
        eventSource.addEventListener('message.delta', (e: MessageEvent) => {
          try {
            const raw = JSON.parse(e.data);
            const parsed = BrowserMessageDeltaSchema.safeParse(raw);
            const payload = parsed.success ? parsed.data : raw;
            if (!payload.taskId) return;

            const existing = deltaBuffer[payload.taskId];
            if (
              existing &&
              existing.messageId === payload.messageId &&
              existing.runId === payload.runId
            ) {
              existing.content += payload.delta ?? '';
            } else {
              deltaBuffer[payload.taskId] = {
                taskId: payload.taskId,
                runId: payload.runId ?? '',
                messageId: payload.messageId,
                content: payload.delta ?? '',
              };
            }
            if (!deltaFlushTimer) {
              deltaFlushTimer = setTimeout(flushDeltaBuffer, 50);
            }
          } catch {
            // ignore malformed delta
          }
        });

        // Message completed - flush buffer and replace ONLY matching transient stream
        eventSource.addEventListener('message.completed', (e: MessageEvent) => {
          try {
            flushDeltaBuffer();
            const raw = JSON.parse(e.data);
            const parsed = BrowserMessageCompletedSchema.safeParse(raw);
            const payload = parsed.success ? parsed.data : raw;
            const targetTaskId = payload.taskId;
            if (targetTaskId) {
              setStreamingDeltasByTask((prev) => {
                const current = prev[targetTaskId];
                if (current && current.messageId === payload.messageId) {
                  const next = { ...prev };
                  delete next[targetTaskId];
                  return next;
                }
                return prev;
              });

              setTaskMessages(targetTaskId, (prev) => {
                if (prev.some((m) => m.id === payload.messageId)) {
                  return prev.map((m) =>
                    m.id === payload.messageId ? { ...m, content: payload.content } : m,
                  );
                }
                const newMsg: Message = {
                  id: payload.messageId,
                  taskId: targetTaskId,
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
              queryClient.invalidateQueries({
                queryKey: queryKeys.messages(selectedTaskIdRef.current),
              });
            }
          }
        });

        // Input required (HITL) - flush buffer and clear transient stream for this task only
        eventSource.addEventListener('input_required', (e: MessageEvent) => {
          try {
            flushDeltaBuffer();
            const raw = JSON.parse(e.data);
            const parsed = BrowserInputRequiredSchema.safeParse(raw);
            const payload = parsed.success ? parsed.data : raw;
            if (payload.taskId) {
              setStreamingDeltasByTask((prev) => {
                if (prev[payload.taskId]) {
                  const next = { ...prev };
                  delete next[payload.taskId];
                  return next;
                }
                return prev;
              });
              setTasks((prev) =>
                prev.map((t) =>
                  t.id === payload.taskId
                    ? { ...t, status: 'hitl', pendingInputRequestId: payload.requestId }
                    : t,
                ),
              );
              queryClient.invalidateQueries({
                queryKey: queryKeys.messages(payload.taskId),
              });
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
          // On disconnect/reconnect, transient deltas are discarded
          setStreamingDeltasByTask({});
          reconnectAttempts++;
          // Bounded exponential backoff with jitter (1s - 10s)
          const delay = Math.min(1000 * 1.5 ** reconnectAttempts + Math.random() * 500, 10000);
          clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(connect, delay);
        };
      } catch {
        // Fallback polling if SSE cannot connect
        reconnectAttempts++;
        const delay = Math.min(2000 * 1.5 ** reconnectAttempts, 10000);
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connect, delay);
      }
    };

    connect();

    return () => {
      if (eventSource) eventSource.close();
      clearTimeout(reconnectTimeout);
      if (deltaFlushTimer) clearTimeout(deltaFlushTimer);
    };
  }, [loadData, setTasks, setTaskMessages, queryClient]);

  // Keyboard shortcuts: ⌘K / Ctrl+K for search, ArrowUp/ArrowDown for task navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setIsCreateModalOpen(false);
        setIsEditModalOpen(false);
        setIsSettingsModalOpen(false);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const active = document.activeElement;
        const tag = (active?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (active as HTMLElement)?.isContentEditable) {
          return;
        }
        const currentTasks = filteredTasksRef.current;
        if (currentTasks.length === 0) return;
        e.preventDefault();
        const currentIndex = currentTasks.findIndex((t) => t.id === selectedTaskIdRef.current);
        if (e.key === 'ArrowDown') {
          const nextIndex = currentIndex < currentTasks.length - 1 ? currentIndex + 1 : 0;
          setSelectedTaskId(currentTasks[nextIndex].id);
        } else {
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : currentTasks.length - 1;
          setSelectedTaskId(currentTasks[prevIndex].id);
        }
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

  const filteredTasksRef = useRef<Task[]>([]);
  filteredTasksRef.current = filteredTasks;

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
    setIsActionLoading(true);
    try {
      const created = await createTask(input);
      queryClient.setQueryData<Task[]>(queryKeys.tasks(), (prev = []) => [created, ...prev]);
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
      setSelectedTaskId(created.id);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleEditTask = async (id: string, input: UpdateTaskInput) => {
    setIsActionLoading(true);
    try {
      const updated = await updateTask(id, input);
      queryClient.setQueryData<Task[]>(queryKeys.tasks(), (prev = []) =>
        prev.map((t) => (t.id === id ? updated : t)),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCancelTask = async () => {
    if (!selectedTask || isActionLoading) return;
    const targetId = selectedTask.id;
    try {
      setIsActionLoading(true);
      const cancelled = await cancelTask(targetId);
      queryClient.setQueryData<Task[]>(queryKeys.tasks(), (prev = []) =>
        prev.map((t) => (t.id === targetId ? cancelled : t)),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to cancel task');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRetryTask = async () => {
    if (!selectedTask || isActionLoading) return;
    const targetId = selectedTask.id;
    try {
      setIsActionLoading(true);
      const retried = await retryTask(targetId);
      queryClient.setQueryData<Task[]>(queryKeys.tasks(), (prev = []) =>
        prev.map((t) => (t.id === targetId ? retried : t)),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks() });
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
    queryClient.setQueryData<Repository[]>(queryKeys.repositories, (prev = []) => [
      ...prev,
      created,
    ]);
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
  };

  const handleSendMessage = async (
    targetTaskId: string,
    content: string,
    inReplyToRequestId?: string,
  ) => {
    if (!targetTaskId) return;
    setSendingTaskIds((prev) => new Set(prev).add(targetTaskId));
    try {
      const newMsg = await postMessage(targetTaskId, {
        content,
        inReplyToRequestId,
      });
      setTaskMessages(targetTaskId, (prev) => {
        if (prev.some((m) => m.id === newMsg.id)) {
          return prev;
        }
        return [...prev, newMsg];
      });
      // If replying to HITL, task transitions to processing
      if (inReplyToRequestId) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === targetTaskId ? { ...t, status: 'processing', pendingInputRequestId: null } : t,
          ),
        );
      }
    } finally {
      setSendingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(targetTaskId);
        return next;
      });
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
          {isTasksLoading && tasks.length === 0 && (
            // biome-ignore lint/a11y/useSemanticElements: live loading status container
            <div className="sidebar-empty-state" role="status">
              <p>Loading tasks...</p>
            </div>
          )}

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

          {!isTasksLoading && tasks.length === 0 && (
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

          {tasks.length > 0 && filteredTasks.length === 0 && (
            <div className="sidebar-empty-state sidebar-search-empty">
              <p>No tasks match "{searchQuery}".</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setSearchQuery('')}
              >
                Clear search
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <AvatarMenu onOpenSettings={() => setIsSettingsModalOpen(true)} userInitials="U" />
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
              streamingDelta={
                selectedTask ? (streamingDeltasByTask[selectedTask.id] ?? null) : null
              }
              onSendMessage={(content, inReplyTo) =>
                handleSendMessage(selectedTask.id, content, inReplyTo)
              }
              isSending={sendingTaskIds.has(selectedTask.id)}
              hasMoreMessages={hasNextPage}
              isLoadingMore={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
              draft={selectedTask ? (draftsByTask[selectedTask.id] ?? '') : ''}
              onDraftChange={(val) => {
                if (selectedTask) {
                  setDraftsByTask((prev) => ({ ...prev, [selectedTask.id]: val }));
                }
              }}
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

export default function App({ client = defaultQueryClient }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <AppContent />
    </QueryClientProvider>
  );
}
