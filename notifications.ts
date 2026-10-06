import { getNextScheduledDeadline, getReminderInterval, type Task } from './pages';

export const DEFAULT_REMINDER_PERCENT = 20;
export const FREQUENT_REMINDER_STEP = 20;

export type PlannedNotification = { at: number; title: string; body: string };

export function formatMinutes(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} min`;
}

// The window a task's reminders are spread over: from when it was created (or, for repeating
// tasks, the start of the current cycle) until its next deadline.
export function getTaskWindow(task: Task, now: number) {
  const deadline = getNextScheduledDeadline(task, now);
  const createdAt = task.createdAt ?? (Number(task.id) || now);
  const start = task.frequency === 'Once'
    ? Math.min(createdAt, deadline)
    : Math.max(createdAt, deadline - getReminderInterval(task, now, deadline));
  return { start, deadline };
}

// Every notification for the task's next deadline that is still in the future.
export function planTaskNotifications(task: Task, now: number, defaultPercent: number) {
  const { start, deadline } = getTaskWindow(task, now);
  const span = Math.max(deadline - start, 0);
  const planned: PlannedNotification[] = [];

  if (task.frequentReminders) {
    for (let passed = FREQUENT_REMINDER_STEP; passed < 100; passed += FREQUENT_REMINDER_STEP) {
      planned.push({
        at: start + span * (passed / 100),
        title: 'Task reminder',
        body: `${passed}% of the time for "${task.title}" has passed. ${100 - passed}% left.`,
      });
    }
  } else if (task.customReminderMinutes) {
    planned.push({
      at: deadline - task.customReminderMinutes * 60000,
      title: 'Task reminder',
      body: `"${task.title}" is due in ${formatMinutes(task.customReminderMinutes)}.`,
    });
  } else {
    planned.push({
      at: deadline - span * (defaultPercent / 100),
      title: 'Task reminder',
      body: `${defaultPercent}% of the time is left for "${task.title}".`,
    });
  }

  planned.push({ at: deadline, title: 'Deadline reached', body: `"${task.title}" is due now.` });
  return { deadline, notifications: planned.filter((item) => item.at > now) };
}
