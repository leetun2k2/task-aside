// Create Task modal dialog (specs/2026-10-25-message-intake/00-overview.md,
// 02-delivery-and-acceptance.md MI-03: "One required Markdown Message,
// collapsed optional fields; no auto-selected repo/P2 override.").
import { useEffect, useRef, useState } from 'react';
import type { CreateTaskInput, Repository, TaskPriority } from '../../contracts/task.ts';
import { Button } from './ui/Button.tsx';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from './ui/Dialog.tsx';
import { IconX } from './ui/Icons.tsx';

interface CreateTaskModalProps {
  isOpen: boolean;
  repositories: Repository[];
  onClose: () => void;
  onSubmit: (input: CreateTaskInput) => Promise<void>;
  prefillParentId?: string;
}

export function CreateTaskModal({
  isOpen,
  repositories,
  onClose,
  onSubmit,
  prefillParentId,
}: CreateTaskModalProps) {
  const [message, setMessage] = useState('');
  const [showOptional, setShowOptional] = useState(false);
  const [title, setTitle] = useState('');
  const [repoIds, setRepoIds] = useState<string[]>([]);
  // Unset means "let Intake resolve it" — never sent as an implicit P2
  // override (01-contracts-and-lifecycle.md "Omission means auto-resolve;
  // it must not be confused with explicit P2.").
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [parentId, setParentId] = useState(prefillParentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setMessage('');
      setShowOptional(false);
      setTitle('');
      setRepoIds([]);
      setPriority('');
      setParentId(prefillParentId ?? '');
      setError(null);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, prefillParentId]);

  const toggleRepo = (id: string) => {
    setRepoIds((current) =>
      current.includes(id) ? current.filter((r) => r !== id) : [...current, id],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!message.trim()) {
      setError('Message is required');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onSubmit({
        message: message.trim(),
        title: title.trim() || undefined,
        repoIds: repoIds.length > 0 ? repoIds : undefined,
        priority: priority || undefined,
        parentId: parentId.trim() || undefined,
      });
      setMessage('');
      setTitle('');
      setRepoIds([]);
      setPriority('');
      setParentId('');
      setShowOptional(false);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle id="modal-title">New Task</DialogTitle>
          <DialogClose className="modal-close-btn" aria-label="Close">
            <IconX size={15} />
          </DialogClose>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && (
              <div className="form-error-banner" role="alert">
                {error}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="task-message" className="form-label">
                Message <span className="required-star">*</span>
              </label>
              <textarea
                id="task-message"
                className="form-textarea"
                rows={6}
                placeholder="Describe what you want done, in Markdown. Repository, title and priority are optional — Intake resolves them."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                autoFocus
                disabled={isSubmitting}
              />
            </div>

            {!showOptional ? (
              <button
                type="button"
                className="form-optional-toggle"
                onClick={() => setShowOptional(true)}
              >
                + Title, repository hints, priority, parent (optional)
              </button>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="task-title" className="form-label">
                    Title <span className="optional-label">(optional — overrides Intake)</span>
                  </label>
                  <input
                    id="task-title"
                    type="text"
                    className="form-input"
                    placeholder="Leave empty to let Intake generate one"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>

                <div className="form-row">
                  <div className="form-group form-col">
                    <span className="form-label">
                      Repository hints <span className="optional-label">(optional)</span>
                    </span>
                    {repositories.length === 0 ? (
                      <p className="form-hint">No repositories registered yet.</p>
                    ) : (
                      <div className="form-checkbox-list">
                        {repositories.map((repo) => (
                          <label key={repo.id} className="form-checkbox-item">
                            <input
                              type="checkbox"
                              checked={repoIds.includes(repo.id)}
                              onChange={() => toggleRepo(repo.id)}
                              disabled={isSubmitting}
                            />
                            {repo.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="form-group form-col">
                    <label htmlFor="task-priority" className="form-label">
                      Priority <span className="optional-label">(optional)</span>
                    </label>
                    <select
                      id="task-priority"
                      className="form-select"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as TaskPriority | '')}
                      disabled={isSubmitting}
                    >
                      <option value="">Auto (Intake decides)</option>
                      <option value="P0">P0 · Critical</option>
                      <option value="P1">P1 · High</option>
                      <option value="P2">P2 · Normal</option>
                      <option value="P3">P3 · Low</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="task-parent" className="form-label">
                    Parent Task ID <span className="optional-label">(optional)</span>
                  </label>
                  <input
                    id="task-parent"
                    type="text"
                    className="form-input"
                    placeholder="Leave empty for root task"
                    value={parentId}
                    onChange={(e) => setParentId(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </>
            )}
          </div>

          <div className="modal-footer">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
