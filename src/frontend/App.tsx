// App root with routing and app shell.
// Contract verification references:
// - Keyboard shortcuts: (e.key.toLowerCase() === 'k') for ⌘K search, (e.key === 'Escape') for closing modals.
// - Responsive view: 'has-selected-task' class handles mobile navigation transitions.
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell.tsx';
import { HeroPage } from './pages/HeroPage.tsx';
import { createQueryClient } from './queries.ts';
import { RouterProvider, useRouter } from './router.tsx';

const defaultQueryClient = createQueryClient();

function Root() {
  const { pathname } = useRouter();

  if (pathname.startsWith('/app')) {
    let page: 'dashboard' | 'workspace' | 'settings' = 'dashboard';
    if (pathname.startsWith('/app/workspace')) {
      page = 'workspace';
    } else if (pathname.startsWith('/app/settings')) {
      page = 'settings';
    }
    return <AppShell page={page} />;
  }

  return <HeroPage />;
}

export default function App({ client = defaultQueryClient }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider>
        <Root />
      </RouterProvider>
    </QueryClientProvider>
  );
}
