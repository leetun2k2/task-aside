import { useEffect, useState } from 'react';
import type { Diagnostics } from '../../../contracts/settings.ts';
import { fetchSettings } from '../../api.ts';
import { Button } from '../../components/ui/Button.tsx';
import { IconRotateCw } from '../../components/ui/Icons.tsx';

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export function DiagnosticsTab() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiagnostics = async (isManual = false) => {
    try {
      if (isManual) setIsRefreshing(true);
      else setIsLoading(true);
      setError(null);
      const res = await fetchSettings();
      setDiagnostics(res.diagnostics ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch diagnostics');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadDiagnostics(false);
  }, []);

  return (
    <div className="settings-tab-pane">
      <div className="settings-tab-header-row">
        <div>
          <h2 className="settings-tab-title">Service Diagnostics</h2>
          <p className="settings-tab-desc">
            Live internal health, SQLite persistence state, and worker metrics for TaskAside local
            services.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void loadDiagnostics(true)}
          disabled={isLoading || isRefreshing}
          title="Refresh service diagnostics"
        >
          <IconRotateCw size={14} className={isRefreshing ? 'spin-animation' : ''} />
          <span>{isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
        </Button>
      </div>

      {error && (
        <div className="form-error-banner" role="alert" style={{ marginBottom: '16px' }}>
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="settings-loading">Loading service diagnostics...</div>
      ) : diagnostics ? (
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
            <span className="diag-label">SQLite Database Path</span>
            <span className="diag-value diag-value-code">{diagnostics.dbPath}</span>
          </div>
        </div>
      ) : (
        <div className="settings-empty-card">
          <p className="settings-empty-title">Diagnostics Unavailable</p>
          <p className="settings-empty-desc">
            Unable to connect to backend diagnostics service. Ensure the TaskAside backend process
            is running.
          </p>
        </div>
      )}
    </div>
  );
}
