// Create Task modal dialog (SPECIFICATION.md §2 T-01, PRD §3).
import { useState } from 'react';
import type { CreateTaskInput, Repository, TaskPriority } from '../../contracts/task.ts';

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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState(repositories[0]?.id ?? '');
  const [priority, setPriority] = useState<TaskPriority>('P2');
  const [parentId, setParentId] = useState(prefillParentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!repoId && repositories.length > 0) {
      setRepoId(repositories[0].id);
    }
    const targetRepoId = repoId || (repositories[0] ? repositories[0].id : '');
    if (!targetRepoId) {
      setError('Please select or register a repository first');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        repoId: targetRepoId,
        priority,
        parentId: parentId.trim() || undefined,
      });
      // Reset form
      setTitle('');
      setDescription('');
      setParentId('');
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
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
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            New Task
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

            <div className="form-group">
              <label htmlFor="task-title" className="form-label">
                Title <span className="required-star">*</span>
              </label>
              <input
                id="task-title"
                type="text"
                className="form-input"
                placeholder="e.g. Implement authentication endpoints"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="form-row">
              <div className="form-group form-col">
                <label htmlFor="task-repo" className="form-label">
                  Repository <span className="required-star">*</span>
                </label>
                <select
                  id="task-repo"
                  className="form-select"
                  value={repoId || (repositories[0]?.id ?? '')}
                  onChange={(e) => setRepoId(e.target.value)}
                >
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name} ({repo.displayPath})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group form-col">
                <label htmlFor="task-priority" className="form-label">
                  Priority
                </label>
                <select
                  id="task-priority"
                  className="form-select"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                >
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
              />
            </div>

            <div className="form-group">
              <label htmlFor="task-desc" className="form-label">
                Description / Context <span className="optional-label">(optional)</span>
              </label>
              <textarea
                id="task-desc"
                className="form-textarea"
                rows={4}
                placeholder="Task details, instructions, or acceptance requirements..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
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
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
