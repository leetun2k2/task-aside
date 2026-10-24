// Conversation and chat component for TaskAside (SPECIFICATION.md §2 C-01; PRD §3).
import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../contracts/chat.ts';
import type { Task } from '../../contracts/task.ts';
import { MarkdownView } from './MarkdownView.tsx';

export interface StreamingDelta {
  runId: string;
  messageId: string;
  content: string;
}

interface TaskConversationProps {
  task: Task;
  messages: Message[];
  isLoadingMessages: boolean;
  streamingDelta?: StreamingDelta | null;
  onSendMessage: (content: string, inReplyToRequestId?: string) => Promise<void>;
  isSending: boolean;
}

function formatRelativeTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    const now = Date.now();
    const diffSecs = Math.floor((now - d.getTime()) / 1000);
    if (diffSecs < 45) return 'just now';
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return '';
  }
}

export function TaskConversation({
  task,
  messages,
  isLoadingMessages,
  streamingDelta,
  onSendMessage,
  isSending,
}: TaskConversationProps) {
  const [inputText, setInputText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages or streaming updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll trigger
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingDelta?.content]);

  // Focus composer when task changes or when entering HITL
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-focus on task change
  useEffect(() => {
    setSendError(null);
    setInputText('');
    textareaRef.current?.focus();
  }, [task.id, task.status]);

  const isHitl = task.status === 'hitl';
  const isProcessing = task.status === 'processing';
  const isTerminal = task.status === 'done' || task.status === 'error' || task.status === 'cancelled';

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const content = inputText.trim();
    if (!content || isSending) return;

    try {
      setSendError(null);
      const replyId = isHitl ? (task.pendingInputRequestId ?? undefined) : undefined;
      await onSendMessage(content, replyId);
      setInputText('');
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message.includes('REQUEST_ALREADY_RESOLVED') || (err as { code?: string }).code === 'REQUEST_ALREADY_RESOLVED') {
          setSendError('This input request has already been resolved.');
        } else {
          setSendError(err.message);
        }
      } else {
        setSendError('Failed to send message');
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="conversation-container">
      {/* Messages Scroll Area */}
      <div className="conversation-messages" role="log" aria-live="polite">
        {isLoadingMessages && messages.length === 0 ? (
          <div className="conversation-loading">
            <span className="spinner-sm" />
            <span>Loading conversation...</span>
          </div>
        ) : messages.length === 0 && !streamingDelta ? (
          <div className="conversation-empty">
            <p className="empty-title">No messages yet</p>
            <p className="empty-subtitle">
              Task #{task.id} is in <strong>{task.status}</strong> state. Send a message to start the
              conversation.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`message-row message-row-${msg.sender}`}
              data-message-id={msg.id}
              data-sender={msg.sender}
            >
              {msg.sender === 'agent' ? (
                <div className="message-avatar message-avatar-agent" title="Agent">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V7h2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-1H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1v-1a5 5 0 0 1 5-5h2V5.72A2 2 0 0 1 12 2Zm-3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-5 6h4a1 1 0 1 0 0-2h-4a1 1 0 1 0 0 2Z" />
                  </svg>
                </div>
              ) : (
                <div className="message-avatar message-avatar-user" title="You">
                  N
                </div>
              )}
              <div className="message-bubble">
                <div className="message-header">
                  <span className="message-sender-name">
                    {msg.sender === 'user' ? 'Nguyen' : 'Harness Agent'}
                  </span>
                  <span className="message-timestamp">{formatRelativeTime(msg.createdAt)}</span>
                  {msg.inReplyToRequestId && (
                    <span className="message-hitl-tag">HITL Reply</span>
                  )}
                </div>
                <MarkdownView content={msg.content} className="message-body" />
              </div>
            </div>
          ))
        )}

        {/* Transient streaming message */}
        {streamingDelta && (
          <div className="message-row message-row-agent message-row-streaming">
            <div className="message-avatar message-avatar-agent" title="Agent">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V7h2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-1H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1v-1a5 5 0 0 1 5-5h2V5.72A2 2 0 0 1 12 2Zm-3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-5 6h4a1 1 0 1 0 0-2h-4a1 1 0 1 0 0 2Z" />
              </svg>
            </div>
            <div className="message-bubble">
              <div className="message-header">
                <span className="message-sender-name">Harness Agent</span>
                <span className="streaming-badge">
                  <span className="streaming-dot" /> Streaming...
                </span>
              </div>
              <MarkdownView content={streamingDelta.content} className="message-body" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* HITL Banner if Human Input is Required */}
      {isHitl && (
        <div className="hitl-banner" role="alert">
          <div className="hitl-banner-icon">⚡</div>
          <div className="hitl-banner-text">
            <strong>Input Required</strong>
            <p>
              The agent has asked a question and paused execution. Type your reply below to safely
              resume execution.
            </p>
          </div>
        </div>
      )}

      {/* Queued Message Notice if Task is Processing */}
      {isProcessing && (
        <div className="queued-turn-banner">
          <span>ℹ Agent is actively running. Messages posted now will be queued for the next safe turn.</span>
        </div>
      )}

      {/* Terminal Message Notice */}
      {isTerminal && (
        <div className="terminal-turn-banner">
          <span>
            Task is {task.status}. Messages sent here are saved to the conversation but will not
            automatically restart execution.
          </span>
        </div>
      )}

      {/* Composer Error Banner */}
      {sendError && (
        <div className="composer-error-banner" role="alert">
          <span>{sendError}</span>
          <button
            type="button"
            className="composer-error-dismiss"
            onClick={() => setSendError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Chat Composer */}
      <form onSubmit={handleSend} className="conversation-composer">
        <textarea
          ref={textareaRef}
          className={`composer-input ${isHitl ? 'composer-input-hitl' : ''}`}
          placeholder={
            isHitl
              ? 'Answer the agent question to resume execution... (⌘↵ to send)'
              : isProcessing
                ? 'Queue a message for the next agent turn... (⌘↵ to send)'
                : 'Send a message to the agent... (⌘↵ to send)'
          }
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSending}
          rows={3}
          aria-label="Message input"
        />

        <div className="composer-actions">
          <div className="composer-actions-left">
            <button
              type="button"
              className="composer-attach-btn"
              title="File attachments are disabled in local-first MVP"
              disabled
              aria-label="Attach file (disabled)"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <span className="composer-hint">Press ⌘↵ or ↵ to send</span>
          </div>

          <button
            type="submit"
            className={`btn ${isHitl ? 'btn-primary btn-hitl-reply' : 'btn-primary btn-send-plane'}`}
            disabled={isSending || !inputText.trim()}
          >
            {isSending ? (
              'Sending...'
            ) : isHitl ? (
              <>
                <span>Reply &amp; Resume</span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="currentColor"
                role="img"
                aria-label="Send"
              >
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
