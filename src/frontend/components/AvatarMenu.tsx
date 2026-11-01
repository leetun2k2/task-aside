// User avatar popup menu in the app header (SPECIFICATION.md §2 T-02, PRD §3).
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme.ts';
import { IconChevronDown, IconMoon, IconSettings, IconSun } from './ui/Icons.tsx';

interface AvatarMenuProps {
  onOpenSettings: () => void;
  userInitials?: string;
  userName?: string;
  username?: string;
}

export function AvatarMenu({ onOpenSettings, userInitials, userName, username }: AvatarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  const displayName = username ?? userName ?? 'User';
  const initials = userInitials ?? (displayName ? displayName.trim().charAt(0).toUpperCase() : 'U');

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  const toggleTheme = () => {
    if (theme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  return (
    <div className="avatar-menu-container" ref={menuRef}>
      {isOpen && (
        <div className="avatar-dropdown-menu" role="menu">
          <div className="avatar-dropdown-header">
            <span className="avatar-dropdown-user">{displayName}</span>
            <span className="avatar-dropdown-role">Local Workspace</span>
          </div>
          <div className="avatar-dropdown-divider" />
          <button
            type="button"
            className="avatar-menu-item"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onOpenSettings();
            }}
          >
            <span className="menu-icon">
              <IconSettings size={15} />
            </span>
            <span>Settings</span>
          </button>
          <button type="button" className="avatar-menu-item" role="menuitem" onClick={toggleTheme}>
            <span className="menu-icon">
              {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
            </span>
            <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
        </div>
      )}

      <button
        type="button"
        className="avatar-button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        title="Account & Settings"
      >
        <span className="avatar-circle">
          <span className="avatar-text">{initials}</span>
        </span>
        <span className="avatar-username">{displayName}</span>
        <IconChevronDown size={14} className={`avatar-chevron ${isOpen ? 'open' : ''}`} />
      </button>
    </div>
  );
}
