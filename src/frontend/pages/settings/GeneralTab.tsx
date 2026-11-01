import { useEffect, useState } from 'react';
import type { SettingsResponse } from '../../../contracts/settings.ts';
import type { Provider } from '../../../contracts/task.ts';
import { fetchSettings, updateSettings } from '../../api.ts';
import { Button } from '../../components/ui/Button.tsx';

interface GeneralTabProps {
  onSettingsChanged?: (settings: SettingsResponse) => void;
}

export function GeneralTab({ onSettingsChanged }: GeneralTabProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider>('claude');
  const [activeHarnesses, setActiveHarnesses] = useState<Provider[]>(['claude', 'codex', 'agy']);
  const [concurrency, setConcurrency] = useState<number>(3);
  const [rootWorkspace, setRootWorkspace] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const res = await fetchSettings();
        if (!mounted) return;
        setSettings(res);
        setSelectedProvider(res.defaultProvider || 'claude');
        setActiveHarnesses(res.activeHarnesses ?? ['claude', 'codex', 'agy']);
        setConcurrency(res.maxConcurrency);
        setRootWorkspace(res.rootWorkspace ?? '');
      } catch (err: unknown) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const toggleHarness = (harness: Provider) => {
    setError(null);
    if (activeHarnesses.includes(harness)) {
      if (activeHarnesses.length <= 1) {
        setError('At least one harness tool must remain active');
        return;
      }
      const next = activeHarnesses.filter((h) => h !== harness);
      setActiveHarnesses(next);
      if (selectedProvider === harness) {
        setSelectedProvider(next[0] as Provider);
      }
    } else {
      setActiveHarnesses([...activeHarnesses, harness]);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSaving(true);
      setError(null);
      setMessage(null);
      const updated = await updateSettings({
        defaultProvider: selectedProvider,
        maxConcurrency: concurrency,
        rootWorkspace: rootWorkspace.trim() ? rootWorkspace.trim() : null,
        activeHarnesses,
      });
      setSettings(updated);
      setMessage('Execution settings saved successfully');
      if (onSettingsChanged) {
        onSettingsChanged(updated);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return <div className="settings-loading">Loading execution settings...</div>;
  }

  return (
    <div className="settings-tab-pane">
      <div className="settings-tab-header">
        <h2 className="settings-tab-title">Execution Settings</h2>
        <p className="settings-tab-desc">
          Configure enabled agent harness runners, default model provider, global concurrency, and
          sandbox safety containment.
        </p>
      </div>

      {error && (
        <div className="form-error-banner" role="alert">
          {error}
        </div>
      )}
      {message && <output className="form-success-banner">{message}</output>}

      <form onSubmit={handleSave} className="settings-form">
        <fieldset className="settings-form-section">
          <legend className="form-label" style={{ marginBottom: '4px', fontWeight: 600 }}>
            Active Harness Tools
          </legend>
          <p className="form-help-text" style={{ marginBottom: '12px' }}>
            Select which agent CLI harnesses are enabled for execution. At least one must be active.
          </p>
          <div className="harness-toggle-group">
            {[
              { id: 'claude' as const, label: 'Claude', desc: 'Claude Code CLI' },
              { id: 'codex' as const, label: 'Codex', desc: 'Codex CLI / App Server' },
              { id: 'agy' as const, label: 'Agy', desc: 'Antigravity CLI' },
            ].map((h) => {
              const isActive = activeHarnesses.includes(h.id);
              return (
                <button
                  key={h.id}
                  type="button"
                  className={`harness-toggle-card ${isActive ? 'harness-toggle-card-active' : ''}`}
                  onClick={() => toggleHarness(h.id)}
                  disabled={isSaving}
                >
                  <div className="harness-toggle-indicator" />
                  <div className="harness-toggle-info">
                    <span className="harness-toggle-name">{h.label}</span>
                    <span className="harness-toggle-desc">{h.desc}</span>
                  </div>
                  <span className="harness-toggle-status">{isActive ? 'Active' : 'Inactive'}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

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
              disabled={isSaving}
            >
              {activeHarnesses.includes('claude') && (
                <option value="claude">Claude (Claude Code CLI)</option>
              )}
              {activeHarnesses.includes('codex') && (
                <option value="codex">Codex (CLI / App Server)</option>
              )}
              {activeHarnesses.includes('agy') && (
                <option value="agy">Agy (Antigravity CLI)</option>
              )}
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
              disabled={isSaving}
            />
            <small className="form-help-text">
              Pool cap: active runs are bounded by the 8-slot worker pool.
            </small>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="settings-root-workspace" className="form-label">
            Root Workspace Directory (Safety Sandbox)
          </label>
          <input
            id="settings-root-workspace"
            type="text"
            className="form-input"
            placeholder="e.g. /Users/username/workspace (leave blank for unrestricted)"
            value={rootWorkspace}
            onChange={(e) => setRootWorkspace(e.target.value)}
            disabled={isSaving}
          />
          <small className="form-help-text">
            Boundary containment: restricts all coding agents and repositories to working strictly
            within this folder to safeguard your entire machine.
          </small>
        </div>

        <div className="form-actions-inline" style={{ marginTop: '16px' }}>
          <Button type="submit" variant="primary" isLoading={isSaving} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save Execution Settings'}
          </Button>
        </div>
      </form>
    </div>
  );
}
