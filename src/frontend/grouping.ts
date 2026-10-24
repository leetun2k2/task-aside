// Task list grouping and collapse hierarchy logic (SPECIFICATION.md §2 T-02, PRD §3).
import type { Task, TaskPriority, TaskStatus } from '../contracts/task.ts';

export type GroupMode = 'state-priority' | 'priority-state';

export interface TaskSubgroup {
  id: string;
  label: string;
  value: string;
  count: number;
  isDefaultCollapsed: boolean;
  tasks: Task[];
}

export interface TaskGroup {
  id: string;
  label: string;
  value: string;
  count: number;
  isDefaultCollapsed: boolean;
  subgroups: TaskSubgroup[];
}

export const STATE_ORDER: TaskStatus[] = [
  'processing',
  'hitl',
  'todo',
  'done',
  'error',
  'cancelled',
];

export const PRIORITY_ORDER: TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];

export const STATE_LABELS: Record<TaskStatus, string> = {
  processing: 'Processing',
  hitl: 'Input Required',
  todo: 'Todo',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  P0: 'P0 · Critical',
  P1: 'P1 · High',
  P2: 'P2 · Normal',
  P3: 'P3 · Low',
};

export function isStateDefaultCollapsed(state: TaskStatus): boolean {
  return state === 'done' || state === 'cancelled';
}

export function groupTasks(tasks: Task[], mode: GroupMode): TaskGroup[] {
  if (mode === 'state-priority') {
    return STATE_ORDER.map((state) => {
      const stateTasks = tasks.filter((t) => t.status === state);
      const subgroups: TaskSubgroup[] = PRIORITY_ORDER.map((priority) => {
        const priorityTasks = stateTasks.filter((t) => t.priority === priority);
        return {
          id: `state-${state}-priority-${priority}`,
          label: PRIORITY_LABELS[priority],
          value: priority,
          count: priorityTasks.length,
          isDefaultCollapsed: false,
          tasks: priorityTasks,
        };
      });

      return {
        id: `state-${state}`,
        label: STATE_LABELS[state],
        value: state,
        count: stateTasks.length,
        isDefaultCollapsed: isStateDefaultCollapsed(state),
        subgroups,
      };
    });
  }

  // Priority → State mode
  return PRIORITY_ORDER.map((priority) => {
    const priorityTasks = tasks.filter((t) => t.priority === priority);
    const subgroups: TaskSubgroup[] = STATE_ORDER.map((state) => {
      const stateTasks = priorityTasks.filter((t) => t.status === state);
      return {
        id: `priority-${priority}-state-${state}`,
        label: STATE_LABELS[state],
        value: state,
        count: stateTasks.length,
        isDefaultCollapsed: isStateDefaultCollapsed(state),
        tasks: stateTasks,
      };
    });

    return {
      id: `priority-${priority}`,
      label: PRIORITY_LABELS[priority],
      value: priority,
      count: priorityTasks.length,
      isDefaultCollapsed: false,
      subgroups,
    };
  });
}

const STORAGE_KEY_GROUP_MODE = 'taskaside:group_mode';
const STORAGE_KEY_COLLAPSED = 'taskaside:collapsed_groups';

export function loadGroupModePreference(): GroupMode {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(STORAGE_KEY_GROUP_MODE);
      if (stored === 'state-priority' || stored === 'priority-state') {
        return stored;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return 'state-priority';
}

export function saveGroupModePreference(mode: GroupMode): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY_GROUP_MODE, mode);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getInitialCollapsedKeys(mode: GroupMode): Set<string> {
  const dummyGroups = groupTasks([], mode);
  const keys = new Set<string>();

  for (const group of dummyGroups) {
    if (group.isDefaultCollapsed) {
      keys.add(group.id);
    }
    for (const sub of group.subgroups) {
      if (sub.isDefaultCollapsed) {
        keys.add(sub.id);
      }
    }
  }

  return keys;
}

export function loadCollapsedPreference(mode: GroupMode): Set<string> {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(`${STORAGE_KEY_COLLAPSED}:${mode}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set<string>(parsed);
        }
      }
    }
  } catch {
    // Ignore storage errors
  }
  return getInitialCollapsedKeys(mode);
}

export function saveCollapsedPreference(mode: GroupMode, collapsed: Set<string>): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(
        `${STORAGE_KEY_COLLAPSED}:${mode}`,
        JSON.stringify(Array.from(collapsed)),
      );
    }
  } catch {
    // Ignore storage errors
  }
}
