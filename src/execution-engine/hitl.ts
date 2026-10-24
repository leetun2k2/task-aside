// Human-in-the-loop (HITL) coordinator for execution engine (ARCHITECTURE.md §8, SPECIFICATION.md §2 C-01, §5; TASKS.md T23).
// Coordinates:
// 1. Structured input requests reaching conversation and pending input pairing.
// 2. Safe resumption of retained owner or queueing after verified stop using declared capabilities.
// 3. Ensuring provider tool permissions cannot be approved by ordinary chat text.
// 4. Rejecting duplicate or stale replies with 409 REQUEST_ALREADY_RESOLVED.
import type { Message } from '../contracts/chat.ts';
import type { AdapterClient, BackendClient } from './client.ts';
import type { RunDispatcher } from './dispatcher.ts';
import type { TaskScheduler } from './scheduler.ts';
import type {
  DispatchResult,
  HitlCoordinatorOptions,
  ResumeHitlParams,
  TaskContext,
  TaskRecord,
} from './types.ts';

export class HitlCoordinator {
  private backendClient: BackendClient;
  private adapterClient: AdapterClient;
  private scheduler: TaskScheduler;
  private dispatcher: RunDispatcher;
  private options: HitlCoordinatorOptions;

  constructor(
    backendClient: BackendClient,
    adapterClient: AdapterClient,
    scheduler: TaskScheduler,
    dispatcher: RunDispatcher,
    options: HitlCoordinatorOptions,
  ) {
    this.backendClient = backendClient;
    this.adapterClient = adapterClient;
    this.scheduler = scheduler;
    this.dispatcher = dispatcher;
    this.options = options;
  }

  /**
   * Asserts that ordinary user chat text CANNOT approve privileged provider tool actions.
   * AGENTS.md rule 7: Never auto-approve privileged provider tool actions by treating them as an ordinary chat question.
   * SPECIFICATION.md §5: Provider tool permission prompts are security-sensitive, use a separate channel from ordinary chat text,
   * and must not be silently approved as if they were ordinary chat.
   */
  canApprovePrivilegedPermissions(_text: string): boolean {
    return false;
  }

  /**
   * Submits a user reply to the conversation on backend.
   * If inReplyToRequestId is provided, backend atomically pairs with pending input request,
   * sets task to processing, and run to running.
   * If duplicate/stale, backend throws 409 REQUEST_ALREADY_RESOLVED.
   */
  async submitReply(
    conversationId: string,
    content: string,
    inReplyToRequestId?: string,
  ): Promise<Message> {
    return this.backendClient.postMessage(conversationId, {
      content,
      inReplyToRequestId,
    });
  }

  /**
   * Submits user reply to backend and resumes execution safely:
   * 1. Posts reply to backend conversation (with atomic HITL pairing).
   * 2. Retrieves updated task context.
   * 3. Resumes execution via RunDispatcher (retained owner or stop-and-resume using declared capabilities).
   */
  async handleReplyAndResume(params: {
    task: TaskRecord;
    claim: { runId: string; generation: number; [key: string]: unknown };
    conversationId: string;
    requestId: string;
    response: string;
    provider?: 'codex' | 'claude';
    sessionId?: string;
    scenario?: string;
  }): Promise<{ message: Message; dispatchResult: DispatchResult }> {
    // 1. Submit reply to backend
    const message = await this.submitReply(
      params.conversationId,
      params.response,
      params.requestId,
    );

    // 2. Fetch updated context with question & reply
    const context = await this.backendClient.getTaskContext(params.task.id);

    // 3. Resume execution on adapter
    const dispatchResult = await this.dispatcher.resumeHitlTask({
      task: params.task,
      claim: params.claim,
      context,
      response: params.response,
      requestId: params.requestId,
      provider: params.provider,
      sessionId: params.sessionId,
      scenario: params.scenario,
    });

    return { message, dispatchResult };
  }
}
