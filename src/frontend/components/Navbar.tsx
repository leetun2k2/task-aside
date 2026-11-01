import { type ReactNode, useState } from 'react';
import { useRouter } from '../router.tsx';

const NAV_COLLAPSE_KEY = 'taskaside:navbar-collapsed';

function loadCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(NAV_COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCollapsedPreference(collapsed: boolean): void {
  try {
    window.localStorage.setItem(NAV_COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    path: '/app',
    label: 'Dashboard',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        role="img"
        aria-label="Dashboard"
      >
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    path: '/app/workspace',
    label: 'Workspace',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        role="img"
        aria-label="Workspace"
      >
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M9 4v16" />
      </svg>
    ),
  },
  {
    path: '/app/settings',
    label: 'Settings',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label="Settings"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
];

export function Navbar({ activePath }: { activePath: string }) {
  const { navigate } = useRouter();
  const [collapsed, setCollapsed] = useState(loadCollapsedPreference);

  const isItemActive = (itemPath: string) => {
    if (itemPath === '/app') {
      return activePath === '/app';
    }
    return activePath.startsWith(itemPath);
  };

  const handleItemClick = (item: NavItem) => {
    if (isItemActive(item.path)) {
      setCollapsed((prev) => {
        const next = !prev;
        saveCollapsedPreference(next);
        return next;
      });
      return;
    }
    navigate(item.path);
  };

  return (
    <nav className={`app-navbar ${collapsed ? 'app-navbar-collapsed' : ''}`}>
      <div className="app-navbar-logo">
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: 'var(--color-primary)' }}
          aria-hidden="true"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        {!collapsed && <span className="app-navbar-logo-text">TaskAside</span>}
      </div>

      <div className="app-navbar-menu">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.path}
            type="button"
            className={`app-navbar-item ${isItemActive(item.path) ? 'app-navbar-item-active' : ''}`}
            onClick={() => handleItemClick(item)}
            title={item.label}
          >
            {item.icon}
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
