// User avatar popup menu in the sidebar footer (SPECIFICATION.md §2 T-02, PRD §3).
import { useEffect, useRef, useState } from 'react';

interface AvatarMenuProps {
  onOpenSettings: () => void;
  userInitials?: string;
}

export function AvatarMenu({ onOpenSettings, userInitials = 'N' }: AvatarMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="avatar-menu-container" ref={menuRef}>
      {isOpen && (
        <div className="avatar-dropdown-menu" role="menu">
          <button
            type="button"
            className="avatar-menu-item"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onOpenSettings();
            }}
          >
            <span className="menu-icon">⚙</span>
            <span>Settings</span>
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
        <span className="avatar-text">{userInitials}</span>
      </button>
    </div>
  );
}
