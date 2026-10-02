export type Task = {
  id: string;
  title: string;
  description: string;
  project: string;
  due: string;
  frequency: Frequency;
  weekdays?: Weekday[];
  scheduledDate?: string;
  scheduledTime?: string;
  done: boolean;
  accent: string;
  allottedMinutes?: number;
  deadline?: number;
  notificationId?: string;
  startedAt?: number;
};

export type TaskTab = 'ongoing' | 'completed';
export type TaskPage = TaskTab | null;
export type Project = 'Personal' | 'Work';
export type ProfileFilter = 'Pending' | 'Completed' | 'Failed' | 'All';
export type AuthMode = 'signin' | 'create';
export type Frequency = 'Once' | 'Daily' | 'Several times weekly' | 'Weekly' | 'Monthly';
export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export const frequencyOptions: Frequency[] = ['Once', 'Daily', 'Several times weekly', 'Weekly', 'Monthly'];
export const weekdayOptions: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const validUsernamePattern = /^[A-Za-z0-9]{4}$/;
export const validPhonePattern = /^\d{9}$/;

export function getScheduleLabel(task: Task) {
  if (task.frequency === 'Once') return `${task.scheduledDate ?? 'Date not set'} at ${task.scheduledTime ?? 'Time not set'}`;
  if (task.frequency === 'Monthly') {
    const day = task.scheduledDate;
    const suffix = day && ['11', '12', '13'].includes(day) ? 'th' : day?.endsWith('1') ? 'st' : day?.endsWith('2') ? 'nd' : day?.endsWith('3') ? 'rd' : 'th';
    return `${day ? `${day}${suffix}` : 'Day not set'} at ${task.scheduledTime ?? 'Time not set'}`;
  }
  const repeat = (task.frequency === 'Several times weekly' || task.frequency === 'Weekly') && task.weekdays?.length ? task.weekdays.join(', ') : task.frequency;
  return `${repeat} at ${task.scheduledTime ?? 'Time not set'}`;
}

export function isTaskFailed(task: Task, currentTime: number) {
  if (task.done) return false;
  if (task.deadline !== undefined) return currentTime >= task.deadline;
  const timeMatch = task.scheduledTime?.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) return false;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours > 23 || minutes > 59) return false;
  const current = new Date(currentTime);
  if (task.frequency === 'Once') {
    const dateMatch = task.scheduledDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return false;
    const scheduled = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes);
    return currentTime >= scheduled.getTime();
  }
  if (task.frequency === 'Monthly' && Number(task.scheduledDate) !== current.getDate()) return false;
  if ((task.frequency === 'Weekly' || task.frequency === 'Several times weekly') && task.weekdays?.length) {
    const dayNames: Weekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (!task.weekdays.includes(dayNames[current.getDay()])) return false;
  }
  const scheduledToday = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes);
  return currentTime >= scheduledToday.getTime();
}

export function getNextScheduledDeadline(task: Task, timestamp: number) {
  const current = new Date(timestamp);
  const match = task.scheduledTime?.match(/^(\d{1,2}):(\d{2})$/);
  const hours = match ? Math.min(23, Number(match[1])) : 23;
  const minutes = match ? Math.min(59, Number(match[2])) : 59;
  const candidate = new Date(current);
  candidate.setHours(hours, minutes, 0, 0);

  if (task.frequency === 'Once' && task.scheduledDate) {
    const dateMatch = task.scheduledDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) return new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes).getTime();
  }
  if (task.frequency === 'Monthly' && task.scheduledDate) {
    const day = Number(task.scheduledDate);
    candidate.setDate(Math.min(day, new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()));
    if (candidate.getTime() <= timestamp) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setDate(Math.min(day, new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()));
    }
    return candidate.getTime();
  }
  if (task.frequency === 'Daily') {
    if (candidate.getTime() <= timestamp) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  const weekdays = task.weekdays?.length ? task.weekdays : ['Mon' as Weekday];
  const dayNames: Weekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = dayNames[(current.getDay() + offset) % 7];
    if (weekdays.includes(day)) {
      const next = new Date(candidate);
      next.setDate(current.getDate() + offset);
      if (next.getTime() > timestamp) return next.getTime();
    }
  }
  return timestamp + 7 * 24 * 60 * 60 * 1000;
}

export function getReminderInterval(task: Task, startedAt: number, deadline: number) {
  if (task.frequency === 'Once') return Math.max(deadline - startedAt, 1000);
  if (task.frequency === 'Daily') return 24 * 60 * 60 * 1000;
  if (task.frequency === 'Monthly') return 30 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

export const initialTasks: Task[] = [
  { id: '1', title: 'Review product roadmap', description: 'Review the latest milestones and prepare notes for the team.', project: 'Work', due: 'Today', frequency: 'Weekly', weekdays: ['Mon'], done: false, accent: '#F0704F', allottedMinutes: 45 },
  { id: '2', title: 'Book dentist appointment', description: 'Call the clinic and find an appointment that works.', project: 'Personal', due: 'Today', frequency: 'Once', done: false, accent: '#6D5DF6', allottedMinutes: 20 },
  { id: '3', title: 'Prepare design feedback', description: 'Collect the open questions and add clear notes to the designs.', project: 'Work', due: 'Tomorrow', frequency: 'Several times weekly', weekdays: ['Tue', 'Thu'], done: false, accent: '#E6A63A', allottedMinutes: 60 },
  { id: '4', title: 'Pick up groceries', description: 'Pick up the items from the saved shopping list.', project: 'Personal', due: 'Friday', frequency: 'Weekly', done: true, accent: '#1FA971', allottedMinutes: 30 },
];