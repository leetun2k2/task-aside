// Edit Task modal dialog (specs/2026-10-25-message-intake/01-contracts-and-
// lifecycle.md): Description is removed; the initial Message can only be
// corrected before first admission (stage 'intake', status 'todo') — after
// that, the backend rejects the edit and a new task-targeted chat message
// is the only way to add instructions.
import { useEffect, useRef, useState } from 'react';
import type { Task, TaskPriority, UpdateTaskInput } from '../../contracts/task.ts';
import { Button } from './ui/Button.tsx';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from './ui/Dialog.tsx';
import { IconX } from './ui/Icons.tsx';

interface EditTaskModalProps {
  task: Task | null;
  /** Current content of the task's initial chat message, looked up by the
   * caller via `task.initialMessageId` — this modal has no message-fetching
   * of its own. */
  initialMessage: string;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (id: string, input: UpdateTaskInput) => Promise<void>;
}

export function EditTaskModal({
  task,
  initialMessage,
  isOpen,
  onClose,
  onSubmit,
}: EditTaskModalProps) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const boundTaskIdRef = useRef<string | null>(null);

  // Synchronize form values strictly when task or modal open state changes
  useEffect(() => {
    if (isOpen && task) {
      if (boundTaskIdRef.current !== task.id) {
        boundTaskIdRef.current = task.id;
        setTitle(task.title);
        setMessage(initialMessage);
        setPriority(task.priority);
        setError(null);
      }
    } else if (!isOpen) {
      boundTaskIdRef.current = null;
    }
  }, [isOpen, task, initialMessage]);

  if (!isOpen || !task) return null;

  const isProcessing = task.status === 'processing';
  const canEditMessage = task.stage === 'intake' && task.status === 'todo';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (isProcessing) {
      setError('Cannot edit a task while it is processing');
      return;
    }
    if (!title.trim()) {
      setError('Title cannot be empty');
      return;
    }

    const targetTaskId = task.id;

    try {
      setIsSubmitting(true);
      setError(null);
      await onSubmit(targetTaskId, {
        title: title.trim(),
        priority,
        message: canEditMessage && message.trim() ? message.trim() : undefined,
      });

      // Guard against race conditions if task selection switched while in-flight
      if (boundTaskIdRef.current === targetTaskId) {
        onClose();
      }
    } catch (err: unknown) {
      // If task switched during save, ignore error from stale task
      if (boundTaskIdRef.current === targetTaskId) {
        setError(err instanceof Error ? err.message : 'Failed to update task');
      }
    } finally {
      if (boundTaskIdRef.current === targetTaskId) {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle id="edit-modal-title">Edit Task #{task.id}</DialogTitle>
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

            {isProcessing && (
              <div className="form-warning-banner" role="alert">
                This task is currently processing. Tasks cannot be edited while an active run is in
                progress.
              </div>
            )}

            <div className="form-group">
              <label htmlFor="edit-task-title" className="form-label">
                Title <span className="required-star">*</span>
              </label>
              <input
                id="edit-task-title"
                type="text"
                className="form-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isProcessing || isSubmitting}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="edit-task-priority" className="form-label">
                Priority
              </label>
              <select
                id="edit-task-priority"
                className="form-select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                disabled={isProcessing || isSubmitting}
              >
                <option value="P0">P0 · Critical</option>
                <option value="P1">P1 · High</option>
                <option value="P2">P2 · Normal</option>
                <option value="P3">P3 · Low</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="edit-task-message" className="form-label">
                Message
                {!canEditMessage && (
                  <span className="optional-label">
                    {' '}
                    (locked — resolved by Intake; post a new message in chat instead)
                  </span>
                )}
              </label>
              <textarea
                id="edit-task-message"
                className="form-textarea"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={isProcessing || isSubmitting || !canEditMessage}
              />
            </div>
          </div>

          <div className="modal-footer">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isSubmitting}
              disabled={isProcessing || isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
