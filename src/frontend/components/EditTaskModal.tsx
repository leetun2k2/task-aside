// Edit Task modal dialog (SPECIFICATION.md §2 T-01, PRD §3).
import { useEffect, useState } from 'react';
import type { Task, TaskPriority, UpdateTaskInput } from '../../contracts/task.ts';

interface EditTaskModalProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (id: string, input: UpdateTaskInput) => Promise<void>;
}

export function EditTaskModal({ task, isOpen, onClose, onSubmit }: EditTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setPriority(task.priority);
      setError(null);
    }
  }, [task]);

  if (!isOpen || !task) return null;

  const isProcessing = task.status === 'processing';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) {
      setError('Cannot edit a task while it is processing');
      return;
    }
    if (!title.trim()) {
      setError('Title cannot be empty');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onSubmit(task.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update task');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes modal
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <dialog
        open
        className="modal-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-labelledby="edit-modal-title"
      >
        <div className="modal-header">
          <h2 id="edit-modal-title" className="modal-title">
            Edit Task #{task.id}
          </h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

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
              <label htmlFor="edit-task-desc" className="form-label">
                Description / Context <span className="optional-label">(optional)</span>
              </label>
              <textarea
                id="edit-task-desc"
                className="form-textarea"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isProcessing || isSubmitting}
              />
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isProcessing || isSubmitting}
            >
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
