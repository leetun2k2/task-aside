// Create Task modal dialog (SPECIFICATION.md §2 T-01, PRD §3).
import { useEffect, useRef, useState } from 'react';
import type { CreateTaskInput, Repository, TaskPriority } from '../../contracts/task.ts';
import { Button } from './ui/Button.tsx';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from './ui/Dialog.tsx';

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

  const prevOpenRef = useRef(false);

  // Reset form whenever modal opens or parentId changes
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setTitle('');
      setDescription('');
      setPriority('P2');
      setParentId(prefillParentId ?? '');
      setRepoId(repositories[0]?.id ?? '');
      setError(null);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, prefillParentId, repositories]);

  // Support late-loaded repositories if repoId is unselected
  useEffect(() => {
    if (isOpen && !repoId && repositories.length > 0) {
      setRepoId(repositories[0].id);
    }
  }, [isOpen, repoId, repositories]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!title.trim()) {
      setError('Title is required');
      return;
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
      // Reset on success
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle id="modal-title">New Task</DialogTitle>
          <DialogClose className="modal-close-btn" aria-label="Close">
            ✕
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
                disabled={isSubmitting}
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
                  disabled={isSubmitting || repositories.length === 0}
                >
                  {repositories.length === 0 ? (
                    <option value="">No repositories registered</option>
                  ) : (
                    repositories.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name} ({repo.displayPath})
                      </option>
                    ))
                  )}
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
                  disabled={isSubmitting}
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
                disabled={isSubmitting}
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
                disabled={isSubmitting}
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
              disabled={isSubmitting || repositories.length === 0}
            >
              {isSubmitting ? 'Creating...' : 'Create Task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
