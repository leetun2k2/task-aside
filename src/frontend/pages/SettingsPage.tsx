import { useEffect } from 'react';
import type { Repository } from '../../contracts/task.ts';
import {
  IconGitBranch,
  IconInfo,
  IconSettings,
  IconSun,
} from '../components/ui/Icons.tsx';
import { useRouter } from '../router.tsx';
import { AppearanceTab } from './settings/AppearanceTab.tsx';
import { DiagnosticsTab } from './settings/DiagnosticsTab.tsx';
import { GeneralTab } from './settings/GeneralTab.tsx';
import { RepositoriesTab } from './settings/RepositoriesTab.tsx';

export type SettingsTabId = 'general' | 'repositories' | 'appearance' | 'diagnostics';

interface SettingsPageProps {
  repositories: Repository[];
  onAddRepository?: (repo: { name: string; displayPath: string }) => Promise<void>;
  onRemoveRepository?: (id: string) => Promise<void>;
}

interface SettingsNavItem {
  id: SettingsTabId;
  label: string;
  desc: string;
  icon: typeof IconSettings;
  badge?: number | string;
}

export function SettingsPage({
  repositories,
  onAddRepository,
  onRemoveRepository,
}: SettingsPageProps) {
  const { pathname, navigate } = useRouter();

  // Determine active tab from pathname
  let activeTab: SettingsTabId = 'general';
  if (pathname.startsWith('/app/settings/repositories')) {
    activeTab = 'repositories';
  } else if (pathname.startsWith('/app/settings/appearance')) {
    activeTab = 'appearance';
  } else if (pathname.startsWith('/app/settings/diagnostics')) {
    activeTab = 'diagnostics';
  } else if (pathname.startsWith('/app/settings/general') || pathname === '/app/settings') {
    activeTab = 'general';
  }

  // Normalize /app/settings to /app/settings/general in the address bar if desired
  useEffect(() => {
    if (pathname === '/app/settings' || pathname === '/app/settings/') {
      navigate('/app/settings/general');
    }
  }, [pathname, navigate]);

  const navItems: SettingsNavItem[] = [
    {
      id: 'general',
      label: 'General',
      desc: 'Harnesses, concurrency & sandbox',
      icon: IconSettings,
    },
    {
      id: 'repositories',
      label: 'Repositories',
      desc: 'Registered Git repositories',
      icon: IconGitBranch,
      badge: repositories.length,
    },
    {
      id: 'appearance',
      label: 'Appearance',
      desc: 'Theme & interface mode',
      icon: IconSun,
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      desc: 'Service health & SQLite status',
      icon: IconInfo,
    },
  ];

  return (
    <div className="settings-page-container">
      {/* Settings Sub-Sidebar */}
      <aside className="settings-sub-sidebar" aria-label="Settings Navigation">
        <div className="settings-sidebar-header">
          <h1 className="settings-sidebar-title">Settings</h1>
          <p className="settings-sidebar-subtitle">Manage workspace preferences</p>
        </div>

        <nav className="settings-nav-list" role="tablist">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`settings-nav-item ${isActive ? 'settings-nav-item-active' : ''}`}
                onClick={() => navigate(`/app/settings/${item.id}`)}
              >
                <div className="settings-nav-icon-wrap">
                  <Icon size={16} />
                </div>
                <div className="settings-nav-text">
                  <span className="settings-nav-label">{item.label}</span>
                  <span className="settings-nav-desc">{item.desc}</span>
                </div>
                {item.badge !== undefined && (
                  <span className="settings-nav-badge">{item.badge}</span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Settings Main Content Area */}
      <main className="settings-main-pane">
        <div className="settings-content-wrapper">
          {activeTab === 'general' && <GeneralTab />}
          {activeTab === 'repositories' && (
            <RepositoriesTab
              repositories={repositories}
              onAddRepository={onAddRepository}
              onRemoveRepository={onRemoveRepository}
            />
          )}
          {activeTab === 'appearance' && <AppearanceTab />}
          {activeTab === 'diagnostics' && <DiagnosticsTab />}
        </div>
      </main>
    </div>
  );
}
