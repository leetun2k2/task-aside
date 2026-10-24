// Backend and Adapter HTTP clients for execution engine (AGENTS.md §3, ARCHITECTURE.md §2.2, §5).
// Strictly uses loopback internal HTTP endpoints with internal.token and X-TaskAside-Role: engine.
// Architecture boundary: no direct SQLite access in execution engine.
import type { CreateMessageInput, Message } from '../contracts/chat.ts';
import {
  type EventEnvelope,
  EventEnvelopeSchema,
  type IngestEventsRequest,
} from '../contracts/event.ts';
import { CONTROL_REQUEST_TIMEOUT_MS } from '../contracts/pool.ts';
import {
  type AdmitTaskRequest,
  type AdmitTaskResponse,
  type CancelRunRequest,
  type CapabilitiesResponse,
  CapabilitiesResponseSchema,
  type ClaimTaskRequest,
  type ClaimTaskResponse,
  type ClearQuarantineRequest,
  type FinalizeRunRequest,
  type HeartbeatRequest,
  type MarkUncertainRequest,
  type ProvideInputRequest,
  type RunStatusResponse,
  RunStatusResponseSchema,
  type StartRunRequest,
} from '../contracts/run.ts';
import type { Settings } from '../contracts/settings.ts';
import type {
  AdapterClientOptions,
  BackendClientOptions,
  CancelRunResult,
  FetchLike,
  IngestEventsResponse,
  RunStatusRecord,
  StartRunResult,
  TaskContext,
  TaskRecord,
} from './types.ts';

export class BackendClientError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'BackendClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class AdapterClientError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'AdapterClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BackendClient {
  private baseUrl: string;
  private internalToken: string;
  private role: string;
  private customFetch?: FetchLike;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.internalToken = options.internalToken;
    this.role = options.role ?? 'engine';
    this.customFetch = options.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const host = new URL(url).host;
    const headers: Record<string, string> = {
      Host: host,
      Authorization: `Bearer ${this.internalToken}`,
      'X-TaskAside-Role': this.role,
      Accept: 'application/json',
      ...extraHeaders,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const requestObj = new Request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bounds control-plane requests only — streamEvents uses its own
      // caller-supplied signal and is never subject to this (SSE streams
      // have no total lifetime limit; specs/2026-10-24-polling-worker-pool.md).
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    });

    const res = await (this.customFetch
      ? this.customFetch(requestObj)
      : globalThis.fetch(requestObj));

    if (!res.ok) {
      let errData: { message?: string; code?: string; details?: unknown } = {};
      try {
        errData = (await res.json()) as { message?: string; code?: string; details?: unknown };
      } catch {
        const text = await res.text().catch(() => '');
        errData = { message: text || res.statusText };
      }
      throw new BackendClientError(
        errData.message || `HTTP ${res.status}: ${res.statusText}`,
        res.status,
        errData.code,
        errData.details,
      );
    }

    return (await res.json()) as T;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async mintManagedMcpToken(runId: string): Promise<{ token: string; expiresAt: string }> {
    return this.request<{ token: string; expiresAt: string }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/mcp-token`,
    );
  }

  async getSettings(): Promise<Settings> {
    return this.request<Settings>('GET', '/api/settings');
  }

  /** @deprecated kept for backward compatibility; the live scheduler uses
   * `admitNextTask` (short indexed selection) instead of fetching the full
   * runnable backlog. */
  async listRunnableTasks(): Promise<TaskRecord[]> {
    return this.request<TaskRecord[]>('GET', '/internal/v1/tasks/runnable');
  }

  async admitNextTask(request: AdmitTaskRequest): Promise<AdmitTaskResponse> {
    return this.request<AdmitTaskResponse>('POST', '/internal/v1/tasks/admit', request);
  }

  async listActiveRuns(): Promise<RunStatusRecord[]> {
    return this.request<RunStatusRecord[]>('GET', '/internal/v1/runs/active');
  }

  async claimTask(taskId: string, request: ClaimTaskRequest): Promise<ClaimTaskResponse> {
    return this.request<ClaimTaskResponse>(
      'POST',
      `/internal/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      request,
    );
  }

  async getTaskContext(taskId: string): Promise<TaskContext> {
    return this.request<TaskContext>(
      'GET',
      `/internal/v1/tasks/${encodeURIComponent(taskId)}/context`,
    );
  }

  async heartbeat(runId: string, request: HeartbeatRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/heartbeat`,
      request,
    );
  }

  async postEvents(
    runId: string,
    request: IngestEventsRequest,
    extraHeaders?: Record<string, string>,
  ): Promise<IngestEventsResponse> {
    return this.request<IngestEventsResponse>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/events`,
      request,
      extraHeaders,
    );
  }

  async finalize(
    runId: string,
    request: FinalizeRunRequest,
  ): Promise<{ ok: boolean; status: string }> {
    return this.request<{ ok: boolean; status: string }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/finalize`,
      request,
    );
  }

  async markUncertain(
    runId: string,
    request: MarkUncertainRequest,
  ): Promise<{ ok: boolean; status: string }> {
    return this.request<{ ok: boolean; status: string }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/mark-uncertain`,
      request,
    );
  }

  async clearQuarantine(runId: string, request: ClearQuarantineRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/clear-quarantine`,
      request,
    );
  }

  async retryTask(taskId: string): Promise<TaskRecord> {
    return this.request<TaskRecord>('POST', `/api/tasks/${encodeURIComponent(taskId)}/retry`);
  }

  async cancelTask(taskId: string): Promise<TaskRecord> {
    return this.request<TaskRecord>('POST', `/api/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  async requestTimeout(runId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/request-timeout`,
    );
  }

  async getRun(runId: string): Promise<RunStatusRecord> {
    return this.request<RunStatusRecord>('GET', `/internal/v1/runs/${encodeURIComponent(runId)}`);
  }

  async postMessage(conversationId: string, input: CreateMessageInput): Promise<Message> {
    return this.request<Message>(
      'POST',
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      input,
    );
  }

  async getTaskMessages(
    taskId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ messages: Message[]; nextCursor: string | null }>(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/messages${qs}`,
    );
  }
}

export class AdapterClient {
  private baseUrl: string;
  private internalToken: string;
  private role: string;
  private customFetch?: FetchLike;

  constructor(options: AdapterClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.internalToken = options.internalToken;
    this.role = options.role ?? 'engine';
    this.customFetch = options.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const host = new URL(url).host;
    const headers: Record<string, string> = {
      Host: host,
      Authorization: `Bearer ${this.internalToken}`,
      'X-TaskAside-Role': this.role,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const requestObj = new Request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bounds control-plane requests only — streamEvents below uses its own
      // caller-supplied signal and is never subject to this.
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    });

    const res = await (this.customFetch
      ? this.customFetch(requestObj)
      : globalThis.fetch(requestObj));

    if (!res.ok) {
      let errData: { message?: string; code?: string; details?: unknown } = {};
      try {
        errData = (await res.json()) as { message?: string; code?: string; details?: unknown };
      } catch {
        const text = await res.text().catch(() => '');
        errData = { message: text || res.statusText };
      }
      throw new AdapterClientError(
        errData.message || `HTTP ${res.status}: ${res.statusText}`,
        res.status,
        errData.code,
        errData.details,
      );
    }

    return (await res.json()) as T;
  }

  async getCapabilities(): Promise<CapabilitiesResponse> {
    const raw = await this.request<unknown>('GET', '/capabilities');
    return CapabilitiesResponseSchema.parse(raw);
  }

  async startRun(
    request: StartRunRequest,
    extraBody?: Record<string, unknown>,
  ): Promise<StartRunResult> {
    const payload = extraBody ? { ...request, ...extraBody } : request;
    return this.request<StartRunResult>('POST', '/internal/v1/runs', payload);
  }

  async getRunStatus(runId: string): Promise<RunStatusResponse> {
    const raw = await this.request<unknown>(
      'GET',
      `/internal/v1/runs/${encodeURIComponent(runId)}`,
    );
    return RunStatusResponseSchema.parse(raw);
  }

  async provideInput(runId: string, request: ProvideInputRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/input`,
      request,
    );
  }

  async cancelRun(runId: string, request: CancelRunRequest = {}): Promise<CancelRunResult> {
    return this.request<CancelRunResult>(
      'POST',
      `/internal/v1/runs/${encodeURIComponent(runId)}/cancel`,
      request,
    );
  }

  async streamEvents(
    runId: string,
    after = 0,
    options: {
      onEvent?: (event: EventEnvelope) => void | Promise<void>;
      signal?: AbortSignal;
    } = {},
  ): Promise<EventEnvelope[]> {
    const url = `${this.baseUrl}/internal/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`;
    const host = new URL(url).host;
    const req = new Request(url, {
      method: 'GET',
      headers: {
        Host: host,
        Authorization: `Bearer ${this.internalToken}`,
        'X-TaskAside-Role': this.role,
        Accept: 'text/event-stream',
      },
      signal: options.signal,
    });

    const res = await (this.customFetch ? this.customFetch(req) : globalThis.fetch(req));
    if (!res.ok) {
      throw new AdapterClientError(
        `SSE request failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }

    if (!res.body) {
      return [];
    }

    const events: EventEnvelope[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (options.signal) {
      if (options.signal.aborted) {
        return [];
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (true) {
        if (options.signal?.aborted) {
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? '';

        for (const block of parts) {
          if (!block.trim()) continue;
          const lines = block.split(/\r?\n/);
          let eventType = '';
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          if (eventType === 'event' && dataStr) {
            try {
              const parsed = EventEnvelopeSchema.parse(JSON.parse(dataStr));
              events.push(parsed);
              if (options.onEvent) {
                await options.onEvent(parsed);
              }
            } catch {
              // Ignore invalid JSON or non-envelope frames
            }
          }
        }
      }

      if (buffer.trim()) {
        const lines = buffer.split(/\r?\n/);
        let eventType = '';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr += line.slice(5).trim();
          }
        }
        if (eventType === 'event' && dataStr) {
          try {
            const parsed = EventEnvelopeSchema.parse(JSON.parse(dataStr));
            events.push(parsed);
            if (options.onEvent) {
              await options.onEvent(parsed);
            }
          } catch {
            // Ignore
          }
        }
      }
    } finally {
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      reader.releaseLock();
    }

    return events;
  }
}
