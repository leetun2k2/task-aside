// Settings modal dialog (SPECIFICATION.md §3, §8.1; PRD §3; TASKS.md T27).
import { useEffect, useState } from 'react';
import type { Diagnostics, SettingsResponse } from '../../contracts/settings.ts';
import type { Provider, Repository } from '../../contracts/task.ts';
import { fetchSettings, updateSettings } from '../api.ts';

interface SettingsModalProps {
  isOpen: boolean;
  repositories: Repository[];
  onClose: () => void;
  onAddRepository?: (repo: { name: string; displayPath: string }) => Promise<void>;
  onSettingsChanged?: (settings: SettingsResponse) => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function SettingsModal({
  isOpen,
  repositories,
  onClose,
  onAddRepository,
  onSettingsChanged,
}: SettingsModalProps) {
  // Repository state
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [isAddingRepo, setIsAddingRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  // General settings state
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('codex');
  const [concurrency, setConcurrency] = useState<number>(3);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Load settings on modal open
  useEffect(() => {
    if (!isOpen) {
      setNewRepoName('');
      setNewRepoPath('');
      setRepoError(null);
      setSettingsMessage(null);
      setSettingsError(null);
      return;
    }

    const load = async () => {
      try {
        setIsLoadingSettings(true);
        setSettingsError(null);
        const res = await fetchSettings();
        setSettings(res);
        setSelectedProvider(res.defaultProvider);
        setConcurrency(res.maxConcurrency);
      } catch (err: unknown) {
        setSettingsError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setIsLoadingSettings(false);
      }
    };

    void load();
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || !newRepoPath.trim()) {
      setRepoError('Name and path are required');
      return;
    }

    try {
      setIsAddingRepo(true);
      setRepoError(null);
      if (onAddRepository) {
        await onAddRepository({
          name: newRepoName.trim(),
          displayPath: newRepoPath.trim(),
        });
      }
      setNewRepoName('');
      setNewRepoPath('');
    } catch (err: unknown) {
      setRepoError(err instanceof Error ? err.message : 'Failed to register repository');
    } finally {
      setIsAddingRepo(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSavingSettings(true);
      setSettingsError(null);
      setSettingsMessage(null);
      const updated = await updateSettings({
        defaultProvider: selectedProvider,
        maxConcurrency: concurrency,
      });
      setSettings(updated);
      setSettingsMessage('Settings saved successfully');
      if (onSettingsChanged) {
        onSettingsChanged(updated);
      }
    } catch (err: unknown) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleRefreshDiagnostics = async () => {
    try {
      const res = await fetchSettings();
      setSettings(res);
    } catch (err: unknown) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to refresh diagnostics');
    }
  };

  const diagnostics: Diagnostics | null = settings?.diagnostics ?? null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes modal
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <dialog
        open
        className="modal-dialog modal-dialog-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <h2 id="settings-title" className="modal-title">
            Settings & Diagnostics
          </h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body settings-body">
          {/* Section 1: Execution Settings */}
          <section className="settings-section">
            <h3 className="settings-section-title">Execution Settings</h3>
            <p className="settings-section-desc">
              Configure default agent provider and global scheduler concurrency.
            </p>

            {settingsError && (
              <div className="form-error-banner" role="alert">
                {settingsError}
              </div>
            )}
            {settingsMessage && (
              <output className="form-success-banner">
                {settingsMessage}
              </output>
            )}

            {isLoadingSettings ? (
              <div className="settings-loading">Loading settings...</div>
            ) : (
              <form onSubmit={handleSaveSettings} className="settings-form">
                <div className="form-row">
                  <div className="form-group form-col">
                    <label htmlFor="settings-provider" className="form-label">
                      Default Provider
                    </label>
                    <select
                      id="settings-provider"
                      className="form-select"
                      value={selectedProvider}
                      onChange={(e) => setSelectedProvider(e.target.value as Provider)}
                      disabled={isSavingSettings}
                    >
                      <option value="codex">Codex (CLI / App Server)</option>
                      <option value="claude">Claude (Claude Code CLI)</option>
                    </select>
                  </div>

                  <div className="form-group form-col">
                    <label htmlFor="settings-concurrency" className="form-label">
                      Max Concurrency (1..10)
                    </label>
                    <input
                      id="settings-concurrency"
                      type="number"
                      className="form-input"
                      min={1}
                      max={10}
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      disabled={isSavingSettings}
                    />
                  </div>
                </div>

                <div className="form-actions-inline">
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={isSavingSettings}
                  >
                    {isSavingSettings ? 'Saving...' : 'Save Execution Settings'}
                  </button>
                </div>
              </form>
            )}
          </section>

          {/* Section 2: Registered Repositories */}
          <section className="settings-section">
            <h3 className="settings-section-title">Registered Repositories</h3>
            <p className="settings-section-desc">
              TaskAside executes tasks exclusively inside registered Git repositories.
            </p>

            <div className="settings-repo-list">
              {repositories.length === 0 ? (
                <div className="settings-empty">No repositories registered yet.</div>
              ) : (
                repositories.map((repo) => (
                  <div key={repo.id} className="settings-repo-item">
                    <div className="repo-item-info">
                      <strong className="repo-item-name">{repo.name}</strong>
                      <span className="repo-item-path">{repo.displayPath}</span>
                    </div>
                    <span className="repo-item-provider badge-provider">
                      {repo.defaultProvider}
                    </span>
                  </div>
                ))
              )}
            </div>

            {onAddRepository && (
              <form onSubmit={handleAddRepo} className="settings-add-repo-form">
                <h4 className="settings-subsection-title">Register Repository</h4>
                {repoError && (
                  <div className="form-error-banner" role="alert">
                    {repoError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group form-col">
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Repository Name (e.g. web-app)"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      disabled={isAddingRepo}
                    />
                  </div>
                  <div className="form-group form-col">
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Absolute Path (e.g. /path/to/repo)"
                      value={newRepoPath}
                      onChange={(e) => setNewRepoPath(e.target.value)}
                      disabled={isAddingRepo}
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={isAddingRepo || !newRepoName.trim() || !newRepoPath.trim()}
                >
                  {isAddingRepo ? 'Registering...' : 'Register'}
                </button>
              </form>
            )}
          </section>

          {/* Section 3: Diagnostics */}
          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <h3 className="settings-section-title">Service Diagnostics</h3>
                <p className="settings-section-desc">
                  Internal runtime health and persistence state for local services.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={handleRefreshDiagnostics}
                title="Refresh diagnostics"
              >
                ↻ Refresh
              </button>
            </div>

            {diagnostics ? (
              <div className="diagnostics-grid">
                <div className="diag-item">
                  <span className="diag-label">Service</span>
                  <span className="diag-value">{diagnostics.service}</span>
                </div>
                <div className="diag-item">
                  <span className="diag-label">Version</span>
                  <span className="diag-value">v{diagnostics.version}</span>
                </div>
                <div className="diag-item">
                  <span className="diag-label">Uptime</span>
                  <span className="diag-value">{formatUptime(diagnostics.uptimeSeconds)}</span>
                </div>
                <div className="diag-item">
                  <span className="diag-label">Total Tasks</span>
                  <span className="diag-value">{diagnostics.tasksCount}</span>
                </div>
                <div className="diag-item">
                  <span className="diag-label">Active Runs</span>
                  <span className="diag-value">{diagnostics.activeRunsCount}</span>
                </div>
                <div className="diag-item">
                  <span className="diag-label">SSE Clients</span>
                  <span className="diag-value">{diagnostics.connectedClients}</span>
                </div>
                <div className="diag-item diag-item-wide">
                  <span className="diag-label">Database Path</span>
                  <span className="diag-value diag-value-code">{diagnostics.dbPath}</span>
                </div>
              </div>
            ) : (
              <div className="settings-empty">No diagnostics available.</div>
            )}
          </section>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </dialog>
    </div>
  );
}
