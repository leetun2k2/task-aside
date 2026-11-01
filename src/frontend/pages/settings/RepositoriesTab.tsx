import { useState } from 'react';
import type { Repository } from '../../../contracts/task.ts';
import { Button } from '../../components/ui/Button.tsx';
import { IconGitBranch, IconTrash } from '../../components/ui/Icons.tsx';

interface RepositoriesTabProps {
  repositories: Repository[];
  onAddRepository?: (repo: { name: string; displayPath: string }) => Promise<void>;
  onRemoveRepository?: (id: string) => Promise<void>;
}

export function RepositoriesTab({
  repositories,
  onAddRepository,
  onRemoveRepository,
}: RepositoriesTabProps) {
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || !newRepoPath.trim()) {
      setError('Both repository name and absolute path are required');
      return;
    }

    try {
      setIsAdding(true);
      setError(null);
      if (onAddRepository) {
        await onAddRepository({
          name: newRepoName.trim(),
          displayPath: newRepoPath.trim(),
        });
      }
      setNewRepoName('');
      setNewRepoPath('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register repository');
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemove = async (repo: Repository) => {
    if (!onRemoveRepository) return;
    const confirmed = window.confirm(
      `Are you sure you want to remove repository "${repo.name}"?\nPath: ${repo.displayPath}`,
    );
    if (!confirmed) return;

    try {
      setRemovingId(repo.id);
      setError(null);
      await onRemoveRepository(repo.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove repository');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="settings-tab-pane">
      <div className="settings-tab-header">
        <h2 className="settings-tab-title">Registered Repositories</h2>
        <p className="settings-tab-desc">
          TaskAside executes agent runs strictly inside registered local Git repositories.
        </p>
      </div>

      {error && (
        <div className="form-error-banner" role="alert" style={{ marginBottom: '16px' }}>
          {error}
        </div>
      )}

      {/* List of Repositories */}
      <div className="settings-repo-section">
        <div className="settings-repo-list-header">
          <span className="settings-repo-count-label">
            {repositories.length} {repositories.length === 1 ? 'Repository' : 'Repositories'}{' '}
            Registered
          </span>
        </div>

        {repositories.length === 0 ? (
          <div className="settings-empty-card">
            <IconGitBranch size={32} style={{ color: 'var(--color-text-subtle)', marginBottom: '8px' }} />
            <p className="settings-empty-title">No repositories registered yet</p>
            <p className="settings-empty-desc">
              Register a local Git repository below to allow coding agents to pick up and execute tasks.
            </p>
          </div>
        ) : (
          <div className="settings-repo-grid">
            {repositories.map((repo) => (
              <div key={repo.id} className="settings-repo-card">
                <div className="settings-repo-card-main">
                  <div className="settings-repo-card-icon">
                    <IconGitBranch size={16} />
                  </div>
                  <div className="settings-repo-card-details">
                    <div className="settings-repo-card-title-row">
                      <strong className="settings-repo-card-name">{repo.name}</strong>
                      <span className="badge-provider">{repo.defaultProvider}</span>
                    </div>
                    <code className="settings-repo-card-path" title={repo.displayPath}>
                      {repo.displayPath}
                    </code>
                  </div>
                </div>

                {onRemoveRepository && (
                  <button
                    type="button"
                    className="repo-item-remove-btn"
                    onClick={() => handleRemove(repo)}
                    disabled={removingId === repo.id}
                    title="Remove repository"
                    aria-label={`Remove repository ${repo.name}`}
                  >
                    <IconTrash size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Register Repository Form */}
      {onAddRepository && (
        <div className="settings-add-repo-box">
          <h3 className="settings-subsection-title" style={{ marginBottom: '8px' }}>
            Register New Repository
          </h3>
          <p className="form-help-text" style={{ marginBottom: '14px' }}>
            Provide a short label and the absolute path to a local Git working directory on your disk.
          </p>

          <form onSubmit={handleAdd} className="settings-form">
            <div className="form-row">
              <div className="form-group form-col">
                <label htmlFor="new-repo-name" className="form-label">
                  Repository Name
                </label>
                <input
                  id="new-repo-name"
                  type="text"
                  className="form-input"
                  placeholder="e.g. backend-api"
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  disabled={isAdding}
                />
              </div>
              <div className="form-group form-col">
                <label htmlFor="new-repo-path" className="form-label">
                  Absolute Path
                </label>
                <input
                  id="new-repo-path"
                  type="text"
                  className="form-input"
                  placeholder="e.g. /Users/username/projects/backend-api"
                  value={newRepoPath}
                  onChange={(e) => setNewRepoPath(e.target.value)}
                  disabled={isAdding}
                />
              </div>
            </div>

            <div className="form-actions-inline" style={{ marginTop: '8px' }}>
              <Button
                type="submit"
                variant="primary"
                isLoading={isAdding}
                disabled={isAdding || !newRepoName.trim() || !newRepoPath.trim()}
              >
                {isAdding ? 'Registering...' : 'Register Repository'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
