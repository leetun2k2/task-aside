import { z } from 'zod';
import type { CreateMessageInput, Message } from '../contracts/chat.ts';
import { MessageSchema } from '../contracts/chat.ts';
import type { SettingsResponse, UpdateSettingsInput } from '../contracts/settings.ts';
import { SettingsResponseSchema } from '../contracts/settings.ts';
import type {
  CreateRepositoryInput,
  CreateTaskInput,
  Repository,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from '../contracts/task.ts';
import { RepositorySchema, TaskSchema } from '../contracts/task.ts';

const AUTH_STORAGE_KEY = 'taskaside:auth_token';

export class StorageUnavailableError extends Error {
  constructor(message = 'Session storage is unavailable') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export function getStoredAuthToken(): string | null {
  if (typeof window === 'undefined') return null;

  // Check URL param first (?token=...)
  try {
    const url = new URL(window.location.href);
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) {
      try {
        window.sessionStorage.setItem(AUTH_STORAGE_KEY, tokenParam);
      } catch {
        // Storage is unavailable (e.g. strict private browsing or quota limits).
        // Report recoverable error without logging the credential value.
        console.warn(
          'Session storage is unavailable. Token will remain in memory for this session only.',
        );
      }

      // Strip only 'token' parameter while preserving other query params and hash (SPECIFICATION.md §8.1)
      url.searchParams.delete('token');
      const cleanUrl = `${url.pathname}${url.search ? url.search : ''}${url.hash}`;
      window.history.replaceState(null, '', cleanUrl);

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
    console.warn('Session storage write failed.');
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

export class MalformedResponseError extends ApiError {
  constructor(message = 'Malformed response from server', details?: unknown) {
    super(502, 'MALFORMED_RESPONSE', message, details);
    this.name = 'MalformedResponseError';
  }
}

export interface RequestOptions extends RequestInit {
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

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
    throw err;
  }

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
  const raw = await request<unknown>(path, { method: 'GET', ...options });
  const parsed = z.array(TaskSchema).safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError('Tasks response validation failed', parsed.error.issues);
  }
  return parsed.data;
}

export async function fetchTaskById(id: string, options?: RequestOptions): Promise<Task> {
  const raw = await request<unknown>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'GET',
    ...options,
  });
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      `Task response validation failed for id: ${id}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function createTask(input: CreateTaskInput, options?: RequestOptions): Promise<Task> {
  const raw = await request<unknown>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Created task response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  options?: RequestOptions,
): Promise<Task> {
  const raw = await request<unknown>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    ...options,
  });
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Updated task response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function cancelTask(id: string, options?: RequestOptions): Promise<Task> {
  const raw = await request<unknown>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    ...options,
  });
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Cancelled task response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function retryTask(id: string, options?: RequestOptions): Promise<Task> {
  const raw = await request<unknown>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    ...options,
  });
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Retried task response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function fetchRepositories(options?: RequestOptions): Promise<Repository[]> {
  const raw = await request<unknown>('/api/repositories', { method: 'GET', ...options });
  const parsed = z.array(RepositorySchema).safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Repositories response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function createRepository(
  input: CreateRepositoryInput,
  options?: RequestOptions,
): Promise<Repository> {
  const raw = await request<unknown>('/api/repositories', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
  const parsed = RepositorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Created repository response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function deleteRepository(id: string, options?: RequestOptions): Promise<void> {
  await request<unknown>(`/api/repositories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });
}

export interface MessagesResponse {
  messages: Message[];
  nextCursor: string | null;
}

const MessagesResponseSchema = z.object({
  messages: z.array(MessageSchema),
  nextCursor: z.string().nullable().optional(),
});

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
  const raw = await request<unknown>(path, { method: 'GET', ...options });
  const parsed = MessagesResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError('Messages response validation failed', parsed.error.issues);
  }
  return {
    messages: parsed.data.messages,
    nextCursor: parsed.data.nextCursor ?? null,
  };
}

export async function postMessage(
  taskId: string,
  input: CreateMessageInput,
  options?: RequestOptions,
): Promise<Message> {
  const raw = await request<unknown>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Posted message response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function fetchSettings(options?: RequestOptions): Promise<SettingsResponse> {
  const raw = await request<unknown>('/api/settings', { method: 'GET', ...options });
  const parsed = SettingsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError('Settings response validation failed', parsed.error.issues);
  }
  return parsed.data;
}

export async function updateSettings(
  input: UpdateSettingsInput,
  options?: RequestOptions,
): Promise<SettingsResponse> {
  const raw = await request<unknown>('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
    ...options,
  });
  const parsed = SettingsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedResponseError(
      'Updated settings response validation failed',
      parsed.error.issues,
    );
  }
  return parsed.data;
}
