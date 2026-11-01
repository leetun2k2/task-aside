import type { RefObject } from 'react';
import { AvatarMenu } from './AvatarMenu.tsx';
import { IconSearch } from './ui/Icons.tsx';

interface HeaderProps {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onOpenSettings: () => void;
  onOpenCommandPalette?: () => void;
  userName?: string;
  userInitials?: string;
}

export function Header({
  searchValue = '',
  onOpenSettings,
  onOpenCommandPalette,
  userName = 'User',
  userInitials,
}: HeaderProps) {
  return (
    <header className="app-header">
      <button
        type="button"
        className="app-header-search-box"
        onClick={onOpenCommandPalette}
        title="Open Command Palette (⌘K)"
        aria-label="Search tasks or commands (⌘K)"
      >
        <IconSearch size={15} className="app-header-search-icon" />
        <span className="app-header-search-input app-header-search-fake-input">
          {searchValue || 'Search tasks or commands...'}
        </span>
        <kbd className="search-shortcut">⌘K</kbd>
      </button>

      <AvatarMenu onOpenSettings={onOpenSettings} userName={userName} userInitials={userInitials} />
    </header>
  );
}
