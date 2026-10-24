import type { CreateMessageInput, Message } from '../contracts/chat.ts';
import type { SettingsResponse, UpdateSettingsInput } from '../contracts/settings.ts';
import type {
  CreateRepositoryInput,
  CreateTaskInput,
  Repository,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from '../contracts/task.ts';

const AUTH_STORAGE_KEY = 'taskaside:auth_token';

export function getStoredAuthToken(): string | null {
  if (typeof window === 'undefined') return null;

  // Check URL param first (?token=...)
  try {
    const url = new URL(window.location.href);
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) {
      window.sessionStorage.setItem(AUTH_STORAGE_KEY, tokenParam);
      return tokenParam;
    }
  } catch {
    // Ignore URL parse error
  }

  try {
    return window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, token);
  } catch {
    // Ignore storage error
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends RequestInit {
  token?: string;
  baseUrl?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = options.baseUrl ?? '';
  const token = options.token ?? getStoredAuthToken();

  const headers = new Headers(options.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const hasJson = contentType.includes('application/json');
  const data = hasJson ? await response.json() : await response.text();

  if (!response.ok) {
    const code =
      (data && typeof data === 'object' && 'code' in data
        ? (data as { code: string }).code
        : undefined) ?? 'HTTP_ERROR';
    const message =
      (data && typeof data === 'object' && 'message' in data
        ? (data as { message: string }).message
        : undefined) ?? `HTTP ${response.status}: ${response.statusText}`;
    throw new ApiError(response.status, code, message, data);
  }

  return data as T;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  repositoryId?: string;
  query?: string;
}

export async function fetchTasks(
  filter: ListTasksFilter = {},
  options?: RequestOptions,
): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.priority) params.set('priority', filter.priority);
  if (filter.repositoryId) params.set('repositoryId', filter.repositoryId);
  if (filter.query) params.set('query', filter.query);

  const qs = params.toString();
  const path = `/api/tasks${qs ? `?${qs}` : ''}`;
  return request<Task[]>(path, { method: 'GET', ...options });
}

export async function fetchTaskById(id: string, options?: RequestOptions): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'GET', ...options });
}

export async function createTask(input: CreateTaskInput, options?: RequestOptions): Promise<Task> {
  return request<Task>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  options?: RequestOptions,
): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    ...options,
  });
}

export async function cancelTask(id: string, options?: RequestOptions): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    ...options,
  });
}

export async function retryTask(id: string, options?: RequestOptions): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    ...options,
  });
}

export async function fetchRepositories(options?: RequestOptions): Promise<Repository[]> {
  return request<Repository[]>('/api/repositories', { method: 'GET', ...options });
}

export async function createRepository(
  input: CreateRepositoryInput,
  options?: RequestOptions,
): Promise<Repository> {
  return request<Repository>('/api/repositories', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
}

export interface MessagesResponse {
  messages: Message[];
  nextCursor: string | null;
}

export async function fetchMessages(
  taskId: string,
  filter?: { cursor?: string; limit?: number },
  options?: RequestOptions,
): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  if (filter?.cursor) params.set('cursor', filter.cursor);
  if (filter?.limit) params.set('limit', String(filter.limit));

  const qs = params.toString();
  const path = `/api/tasks/${encodeURIComponent(taskId)}/messages${qs ? `?${qs}` : ''}`;
  return request<MessagesResponse>(path, { method: 'GET', ...options });
}

export async function postMessage(
  taskId: string,
  input: CreateMessageInput,
  options?: RequestOptions,
): Promise<Message> {
  return request<Message>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
}

export async function fetchSettings(options?: RequestOptions): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', { method: 'GET', ...options });
}

export async function updateSettings(
  input: UpdateSettingsInput,
  options?: RequestOptions,
): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
    ...options,
  });
}

