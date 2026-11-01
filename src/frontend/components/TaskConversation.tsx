// Conversation and chat component for TaskAside (SPECIFICATION.md §2 C-01; PRD §3).
import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../contracts/chat.ts';
import type { Task } from '../../contracts/task.ts';
import { MarkdownView } from './MarkdownView.tsx';
import { Button } from './ui/Button.tsx';
import { IconArrowDown, IconInfo, IconSend, IconX, IconZap } from './ui/Icons.tsx';

export interface StreamingDelta {
  taskId?: string;
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
  hasMoreMessages?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  draft?: string;
  onDraftChange?: (draft: string) => void;
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
  hasMoreMessages,
  isLoadingMore,
  onLoadMore,
  draft,
  onDraftChange,
}: TaskConversationProps) {
  const [localInputText, setLocalInputText] = useState('');
  const inputText = draft !== undefined ? draft : localInputText;
  const setInputText = (val: string) => {
    if (onDraftChange) onDraftChange(val);
    else setLocalInputText(val);
  };

  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAtBottomRef = useRef(true);
  const [showFollowLatest, setShowFollowLatest] = useState(false);

  const handleScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceToBottom < 60;
    isAtBottomRef.current = atBottom;
    setShowFollowLatest(!atBottom);
  };

  const scrollToBottom = (behavior?: ScrollBehavior) => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const chosenBehavior = behavior ?? (prefersReducedMotion ? 'auto' : 'smooth');
    messagesEndRef.current?.scrollIntoView({ behavior: chosenBehavior });
    isAtBottomRef.current = true;
    setShowFollowLatest(false);
  };

  // Follow bottom only while reader is already following
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll trigger
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    }
  }, [messages.length, streamingDelta?.content]);

  // Focus composer when task changes or when entering HITL
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-focus on task change
  useEffect(() => {
    setSendError(null);
    textareaRef.current?.focus();
  }, [task.id, task.status]);

  const isHitl = task.status === 'hitl';
  const isProcessing = task.status === 'processing';
  const isTerminal =
    task.status === 'done' || task.status === 'error' || task.status === 'cancelled';

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const content = inputText.trim();
    if (!content || isSending) return;

    try {
      setSendError(null);
      const replyId = isHitl ? (task.pendingInputRequestId ?? undefined) : undefined;
      await onSendMessage(content, replyId);
      setInputText(
        inputText.startsWith(content) ? inputText.slice(content.length).trimStart() : '',
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes('REQUEST_ALREADY_RESOLVED') ||
          (err as { code?: string }).code === 'REQUEST_ALREADY_RESOLVED'
        ) {
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
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="conversation-messages"
        role="log"
        aria-live="polite"
      >
        {isLoadingMessages && messages.length === 0 ? (
          <div className="conversation-loading">
            <span className="spinner-sm" />
            <span>Loading conversation...</span>
          </div>
        ) : messages.length === 0 && !streamingDelta ? (
          <div className="conversation-empty">
            <p className="empty-title">No messages yet</p>
            <p className="empty-subtitle">
              Task #{task.id} is in <strong>{task.status}</strong> state. Send a message to start
              the conversation.
            </p>
          </div>
        ) : (
          <>
            {hasMoreMessages && (
              <div
                className="conversation-load-more"
                style={{ textAlign: 'center', padding: '8px' }}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onLoadMore}
                  isLoading={isLoadingMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? 'Loading more...' : 'Load more messages'}
                </Button>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`message-row message-row-${msg.sender}`}
                data-message-id={msg.id}
                data-sender={msg.sender}
              >
                {msg.sender === 'agent' ? (
                  <div className="message-avatar message-avatar-agent" title="Agent">
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V7h2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-1H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1v-1a5 5 0 0 1 5-5h2V5.72A2 2 0 0 1 12 2Zm-3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-5 6h4a1 1 0 1 0 0-2h-4a1 1 0 1 0 0 2Z" />
                    </svg>
                  </div>
                ) : (
                  <div className="message-avatar message-avatar-user" title="You">
                    U
                  </div>
                )}
                <div className="message-bubble">
                  <div className="message-header">
                    <span className="message-sender-name">
                      {msg.sender === 'user' ? 'You' : 'Agent'}
                    </span>
                    <span className="message-timestamp">{formatRelativeTime(msg.createdAt)}</span>
                    {msg.inReplyToRequestId && <span className="message-hitl-tag">HITL Reply</span>}
                  </div>
                  <MarkdownView content={msg.content} className="message-body" />
                </div>
              </div>
            ))}
          </>
        )}

        {/* Transient streaming message */}
        {streamingDelta && (
          <div className="message-row message-row-agent message-row-streaming">
            <div className="message-avatar message-avatar-agent" title="Agent">
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.38-1 1.72V7h2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-1H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1v-1a5 5 0 0 1 5-5h2V5.72A2 2 0 0 1 12 2Zm-3 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-5 6h4a1 1 0 1 0 0-2h-4a1 1 0 1 0 0 2Z" />
              </svg>
            </div>
            <div className="message-bubble">
              <div className="message-header">
                <span className="message-sender-name">Agent</span>
                <span className="streaming-badge">
                  <span className="streaming-dot" /> Streaming...
                </span>
              </div>
              <MarkdownView content={streamingDelta.content} className="message-body" />
            </div>
          </div>
        )}

        {showFollowLatest && (
          <button
            type="button"
            className="btn-follow-latest"
            onClick={() => scrollToBottom('smooth')}
            style={{
              position: 'sticky',
              bottom: '12px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              padding: '6px 14px',
              borderRadius: '20px',
              boxShadow: '0 4px 14px rgba(99, 102, 241, 0.35)',
              background: 'var(--color-primary-gradient)',
              color: '#ffffff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <IconArrowDown size={13} />
            <span>Jump to latest</span>
          </button>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* HITL Banner if Human Input is Required */}
      {isHitl && (
        <div className="hitl-banner" role="alert">
          <div className="hitl-banner-icon">
            <IconZap size={20} />
          </div>
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <IconInfo size={14} />
            <span>
              Agent is actively running. Messages posted now will be queued for the next safe turn.
            </span>
          </span>
        </div>
      )}

      {/* Terminal Message Notice */}
      {isTerminal && (
        <div className="terminal-turn-banner">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <IconInfo size={14} />
            <span>
              Task is {task.status}. Messages sent here are saved to the conversation but will not
              automatically restart execution.
            </span>
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
            <IconX size={13} />
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
            <span className="composer-hint">Press ⌘↵ or ↵ to send</span>
          </div>

          <Button
            type="submit"
            variant="primary"
            className={isHitl ? 'btn-hitl-reply' : 'btn-send-plane'}
            isLoading={isSending}
            disabled={isSending || !inputText.trim()}
          >
            {isSending ? (
              'Sending...'
            ) : isHitl ? (
              <>
                <span>Reply &amp; Resume</span>
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="currentColor"
                  aria-hidden="true"
                >
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
          </Button>
        </div>
      </form>
    </div>
  );
}
