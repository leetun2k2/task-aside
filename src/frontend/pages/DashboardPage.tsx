import { useQuery } from '@tanstack/react-query';
import type { Repository, Task } from '../../contracts/task.ts';
import { fetchTasks } from '../api.ts';
import {
  IconGitBranch,
  IconStatusCancelled,
  IconStatusDone,
  IconStatusError,
  IconStatusHitl,
  IconStatusProcessing,
  IconStatusTodo,
} from '../components/ui/Icons.tsx';
import { queryKeys } from '../queries.ts';

interface DashboardPageProps {
  repositories: Repository[];
}

const STATUS_CONFIG: Record<
  Task['status'],
  { label: string; icon: typeof IconStatusTodo; color: string }
> = {
  todo: { label: 'Todo', icon: IconStatusTodo, color: 'var(--color-text-subtle)' },
  processing: { label: 'Processing', icon: IconStatusProcessing, color: 'var(--color-primary)' },
  hitl: { label: 'Needs Input', icon: IconStatusHitl, color: '#ea580c' },
  done: { label: 'Done', icon: IconStatusDone, color: '#10b981' },
  error: { label: 'Error', icon: IconStatusError, color: '#ef4444' },
  cancelled: { label: 'Cancelled', icon: IconStatusCancelled, color: 'var(--color-text-subtle)' },
};

export function DashboardPage({ repositories }: DashboardPageProps) {
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: queryKeys.tasks(),
    queryFn: ({ signal }) => fetchTasks({}, { signal }),
  });

  const countsByStatus: Record<Task['status'], number> = {
    todo: 0,
    processing: 0,
    hitl: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    countsByStatus[task.status]++;
  }

  return (
    <div className="dashboard-page">
      <h1 className="dashboard-title">Dashboard</h1>

      {isLoading && tasks.length === 0 ? (
        <p className="dashboard-loading">Loading...</p>
      ) : (
        <>
          <div className="dashboard-stats-row">
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-header">
                <span className="dashboard-stat-label">Total Tasks</span>
              </div>
              <span className="dashboard-stat-value">{tasks.length}</span>
            </div>
            <div className="dashboard-stat-card">
              <div className="dashboard-stat-header">
                <span className="dashboard-stat-label">Repositories</span>
                <IconGitBranch size={16} style={{ color: 'var(--color-primary)' }} />
              </div>
              <span className="dashboard-stat-value">{repositories.length}</span>
            </div>
          </div>

          <div className="dashboard-stats-row">
            {(Object.keys(STATUS_CONFIG) as Task['status'][]).map((status) => {
              const cfg = STATUS_CONFIG[status];
              const Icon = cfg.icon;
              return (
                <div className="dashboard-stat-card" key={status}>
                  <div className="dashboard-stat-header">
                    <span className="dashboard-stat-label">{cfg.label}</span>
                    <Icon size={15} style={{ color: cfg.color }} />
                  </div>
                  <span className="dashboard-stat-value">{countsByStatus[status]}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
