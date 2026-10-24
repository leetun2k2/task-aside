import { QueryClient } from '@tanstack/react-query';
import type { ListTasksFilter } from './api.ts';
import { MalformedResponseError } from './api.ts';

export const queryKeys = {
  tasks: (filter: ListTasksFilter = {}) => ['tasks', filter] as const,
  taskById: (id: string) => ['tasks', 'byId', id] as const,
  repositories: ['repositories'] as const,
  messages: (taskId: string) => ['messages', taskId] as const,
  settings: ['settings'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof MalformedResponseError) {
            return false;
          }
          return failureCount < 2;
        },
      },
    },
  });
}
