import { IconMoon, IconSun } from '../../components/ui/Icons.tsx';
import { type Theme, useTheme } from '../../theme.ts';

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();

  const themes: Array<{
    id: Theme;
    label: string;
    desc: string;
    icon: typeof IconSun;
  }> = [
    {
      id: 'system',
      label: 'System Default',
      desc: 'Automatically matches your macOS or operating system appearance settings',
      icon: IconSun,
    },
    {
      id: 'light',
      label: 'Light Mode',
      desc: 'Clean, high-contrast light theme with dark typography',
      icon: IconSun,
    },
    {
      id: 'dark',
      label: 'Dark Mode',
      desc: 'Low-light dark theme optimized for coding sessions and night work',
      icon: IconMoon,
    },
  ];

  return (
    <div className="settings-tab-pane">
      <div className="settings-tab-header">
        <h2 className="settings-tab-title">Appearance & Theme</h2>
        <p className="settings-tab-desc">
          Customize the visual presentation and color scheme of TaskAside.
        </p>
      </div>

      <div className="settings-appearance-grid">
        {themes.map((t) => {
          const isSelected = theme === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              className={`settings-theme-card ${isSelected ? 'settings-theme-card-selected' : ''}`}
              onClick={() => setTheme(t.id)}
            >
              <div className="settings-theme-card-header">
                <div className="settings-theme-icon-wrap">
                  <Icon size={18} />
                </div>
                <div className="settings-theme-card-text">
                  <strong className="settings-theme-title">{t.label}</strong>
                  <p className="settings-theme-desc">{t.desc}</p>
                </div>
              </div>
              <div className="settings-theme-indicator">
                <div className={`settings-radio-dot ${isSelected ? 'active' : ''}`} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
