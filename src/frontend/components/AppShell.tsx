import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { CreateRepositoryInput, Repository, Task } from '../../contracts/task.ts';
import { createRepository, deleteRepository, fetchRepositories, fetchTasks } from '../api.ts';
import { DashboardPage } from '../pages/DashboardPage.tsx';
import { SettingsPage } from '../pages/SettingsPage.tsx';
import { WorkspacePage } from '../pages/WorkspacePage.tsx';
import { queryKeys } from '../queries.ts';
import { useRouter } from '../router.tsx';
import { CommandPaletteModal } from './CommandPaletteModal.tsx';
import { Header } from './Header.tsx';
import { Navbar } from './Navbar.tsx';
import { SettingsModal } from './SettingsModal.tsx';

export function AppShell({ page }: { page: 'dashboard' | 'workspace' | 'settings' }) {
  const queryClient = useQueryClient();
  const { pathname, navigate } = useRouter();

  const { data: repositories = [] } = useQuery({
    queryKey: queryKeys.repositories,
    queryFn: ({ signal }) => fetchRepositories({ signal }),
  });

  const { data: tasks = [] } = useQuery({
    queryKey: queryKeys.tasks(),
    queryFn: ({ signal }) => fetchTasks({}, { signal }),
  });

  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global ⌘K / Ctrl+K shortcut to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setIsCommandPaletteOpen(false);
        setIsSettingsModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelectTaskFromPalette = (taskId: string) => {
    setSelectedTaskId(taskId);
    if (!pathname.startsWith('/app/workspace')) {
      navigate('/app/workspace');
    }
    setIsCommandPaletteOpen(false);
  };

  const handleAddRepository = async (repo: { name: string; displayPath: string }) => {
    const input: CreateRepositoryInput = {
      name: repo.name,
      displayPath: repo.displayPath,
      defaultProvider: 'codex',
    };
    const created = await createRepository(input);
    queryClient.setQueryData<Repository[]>(queryKeys.repositories, (prev = []) => [
      ...prev,
      created,
    ]);
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
  };

  const handleRemoveRepository = async (id: string) => {
    await deleteRepository(id);
    queryClient.setQueryData<Repository[]>(queryKeys.repositories, (prev = []) =>
      prev.filter((repo) => repo.id !== id),
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.repositories });
  };

  return (
    <div className="app-layout">
      <Navbar activePath={pathname} />

      <div className="app-right">
        <Header
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
          onOpenSettings={() => navigate('/app/settings/general')}
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        />

        <div className="app-content">
          {page === 'dashboard' ? (
            <DashboardPage repositories={repositories} />
          ) : page === 'settings' ? (
            <SettingsPage
              repositories={repositories}
              onAddRepository={handleAddRepository}
              onRemoveRepository={handleRemoveRepository}
            />
          ) : (
            <WorkspacePage
              repositories={repositories}
              searchQuery={searchQuery}
              searchInputRef={searchInputRef}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          )}
        </div>
      </div>

      <CommandPaletteModal
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        tasks={tasks}
        repositories={repositories}
        onSelectTask={handleSelectTaskFromPalette}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        repositories={repositories}
        onClose={() => setIsSettingsModalOpen(false)}
        onAddRepository={handleAddRepository}
        onRemoveRepository={handleRemoveRepository}
      />
    </div>
  );
}
