import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type * as NotificationsModule from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const Notifications: typeof NotificationsModule | null = Constants.appOwnership === 'expo'
  ? null
  : require('expo-notifications');

type CrashState = {
  error?: Error;
  stack?: string;
};

class CrashBoundary extends React.Component<React.PropsWithChildren, CrashState> {
  state: CrashState = {};

  componentDidMount() {
    const errorUtils = (globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
      };
    }).ErrorUtils;
    if (!errorUtils?.setGlobalHandler) return;

    const previousHandler = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal) => {
      this.setState({ error, stack: `${isFatal ? 'Fatal JavaScript error' : 'JavaScript error'}\n\n${error.stack ?? ''}` });
      previousHandler?.(error, isFatal);
    });
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, stack: `${error.stack ?? ''}\n\nComponent stack:\n${info.componentStack}` });
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.crashScreen}>
          <Text style={styles.crashTitle}>Taskflow crashed</Text>
          <Text style={styles.crashMessage}>{this.state.error.message || 'Unknown JavaScript error'}</Text>
          <Text selectable style={styles.crashLog}>{this.state.stack ?? this.state.error.toString()}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

type Task = {
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

type TaskTab = 'ongoing' | 'completed';
type TaskPage = TaskTab | null;
type Project = 'Personal' | 'Work';
type ProfileFilter = 'Pending' | 'Completed' | 'Failed' | 'All';
type AuthMode = 'signin' | 'create';
type Frequency = 'Once' | 'Daily' | 'Several times weekly' | 'Weekly' | 'Monthly';
type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

const frequencyOptions: Frequency[] = ['Once', 'Daily', 'Several times weekly', 'Weekly', 'Monthly'];
const weekdayOptions: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const validUsernamePattern = /^[A-Za-z0-9]{4}$/;
const validPhonePattern = /^\d{9}$/;

function getScheduleLabel(task: Task) {
  if (task.frequency === 'Once') return `${task.scheduledDate ?? 'Date not set'} at ${task.scheduledTime ?? 'Time not set'}`;
  if (task.frequency === 'Monthly') {
    const day = task.scheduledDate;
    const suffix = day && ['11', '12', '13'].includes(day) ? 'th' : day?.endsWith('1') ? 'st' : day?.endsWith('2') ? 'nd' : day?.endsWith('3') ? 'rd' : 'th';
    return `${day ? `${day}${suffix}` : 'Day not set'} at ${task.scheduledTime ?? 'Time not set'}`;
  }
  const repeat = (task.frequency === 'Several times weekly' || task.frequency === 'Weekly') && task.weekdays?.length ? task.weekdays.join(', ') : task.frequency;
  return `${repeat} at ${task.scheduledTime ?? 'Time not set'}`;
}

function isTaskFailed(task: Task, currentTime: number) {
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

function getTaskStatusColor(task: Task, currentTime: number) {
  if (task.done) return '#1FA971';
  if (isTaskFailed(task, currentTime)) return '#E14F3D';
  if (task.deadline !== undefined && task.startedAt && task.deadline - currentTime <= (task.deadline - task.startedAt) * 0.2) return '#E6A63A';
  return '#E6A63A';
}

function getTimeParts(task: Task) {
  const match = task.scheduledTime?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hours: 23, minutes: 59 };
  return { hours: Math.min(23, Number(match[1])), minutes: Math.min(59, Number(match[2])) };
}

function getNextScheduledDeadline(task: Task, timestamp: number) {
  const current = new Date(timestamp);
  const { hours, minutes } = getTimeParts(task);
  const candidate = new Date(current);
  candidate.setHours(hours, minutes, 0, 0);

  if (task.frequency === 'Once' && task.scheduledDate) {
    const dateMatch = task.scheduledDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
      return new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes).getTime();
    }
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

function getReminderInterval(task: Task, startedAt: number, deadline: number) {
  if (task.frequency === 'Once') return Math.max(deadline - startedAt, 1000);
  if (task.frequency === 'Daily') return 24 * 60 * 60 * 1000;
  if (task.frequency === 'Monthly') return 30 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

const initialTasks: Task[] = [
  { id: '1', title: 'Review product roadmap', description: 'Review the latest milestones and prepare notes for the team.', project: 'Work', due: 'Today', frequency: 'Weekly', weekdays: ['Mon'], done: false, accent: '#F0704F', allottedMinutes: 45 },
  { id: '2', title: 'Book dentist appointment', description: 'Call the clinic and find an appointment that works.', project: 'Personal', due: 'Today', frequency: 'Once', done: false, accent: '#6D5DF6', allottedMinutes: 20 },
  { id: '3', title: 'Prepare design feedback', description: 'Collect the open questions and add clear notes to the designs.', project: 'Work', due: 'Tomorrow', frequency: 'Several times weekly', weekdays: ['Tue', 'Thu'], done: false, accent: '#E6A63A', allottedMinutes: 60 },
  { id: '4', title: 'Pick up groceries', description: 'Pick up the items from the saved shopping list.', project: 'Personal', due: 'Friday', frequency: 'Weekly', done: true, accent: '#1FA971', allottedMinutes: 30 },
];

function TaskflowApp() {
  const [tasks, setTasks] = useState(initialTasks);
  const [username, setUsername] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [phoneDraft, setPhoneDraft] = useState('');
  const [projectMode, setProjectMode] = useState<Project>('Personal');
  const [taskProject, setTaskProject] = useState<Project>('Personal');
  const [taskPage, setTaskPage] = useState<TaskPage>(null);
  const [draft, setDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [durationDraft, setDurationDraft] = useState('30');
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('Once');
  const [selectedWeekdays, setSelectedWeekdays] = useState<Weekday[]>([]);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isReminderOpen, setIsReminderOpen] = useState(false);
  const [reminderTaskIds, setReminderTaskIds] = useState<string[]>([]);
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('Pending');
  const [now, setNow] = useState(Date.now());
  const addButtonPosition = React.useRef(new Animated.ValueXY()).current;
  const addButtonPanResponder = React.useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => addButtonPosition.extractOffset(),
    onPanResponderMove: Animated.event(
      [null, { dx: addButtonPosition.x, dy: addButtonPosition.y }],
      { useNativeDriver: false },
    ),
    onPanResponderRelease: () => addButtonPosition.flattenOffset(),
    onPanResponderTerminate: () => addButtonPosition.flattenOffset(),
  })).current;

  useEffect(() => {
    AsyncStorage.multiGet(['taskflow.username', 'taskflow.phone']).then(([savedUsername, savedPhone]) => {
      setUsername(savedUsername[1]);
      setPhoneNumber(savedPhone[1]);
      setUsernameDraft(savedUsername[1] ?? '');
      setPhoneDraft(savedPhone[1] ?? '');
      setProfileLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' || !Notifications) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
    });
    Notifications.setNotificationChannelAsync('task-reminders-custom', {
      name: 'Task reminders',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'task-reminder.mpeg',
      vibrationPattern: [0, 500, 250, 500, 250, 700],
      enableVibrate: true,
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);

  const visibleTasks = useMemo(() => {
    const projectTasks = tasks.filter((task) => task.project === projectMode);
    return projectTasks;
  }, [projectMode, tasks]);

  const projectTasks = tasks.filter((task) => task.project === projectMode);
  const completed = projectTasks.filter((task) => task.done).length;
  const remaining = projectTasks.length - completed;
  const profileTasks = useMemo(() => {
    const uniqueTasks = Array.from(new Map(tasks.map((task) => [`${task.project}|${task.title.trim().toLowerCase()}|${task.frequency}|${task.scheduledDate ?? ''}|${task.scheduledTime ?? ''}`, task])).values());
    if (profileFilter === 'Completed') return uniqueTasks.filter((task) => task.done);
    if (profileFilter === 'Failed') return uniqueTasks.filter((task) => isTaskFailed(task, now));
    if (profileFilter === 'Pending') return uniqueTasks.filter((task) => !task.done && !isTaskFailed(task, now));
    return uniqueTasks;
  }, [now, profileFilter, tasks]);

  const avatarLabel = username?.match(/[a-z0-9]/i)?.[0].toUpperCase() ?? '?';
  const validProfileDetails = validUsernamePattern.test(usernameDraft.trim()) && validPhonePattern.test(phoneDraft.trim());

  async function saveProfile() {
    const name = usernameDraft.trim();
    const phone = phoneDraft.trim();
    if (!validUsernamePattern.test(name)) {
      Alert.alert('Invalid user name', 'User name must be exactly 4 letters or numbers.');
      return;
    }
    if (!validPhonePattern.test(phone)) {
      Alert.alert('Invalid phone number', 'Phone number must be exactly 9 digits.');
      return;
    }
    await AsyncStorage.multiSet([['taskflow.username', name], ['taskflow.phone', phone]]);
    setUsername(name);
    setPhoneNumber(phone);
  }

  async function logout() {
    await AsyncStorage.multiRemove(['taskflow.username', 'taskflow.phone']);
    setUsername(null);
    setPhoneNumber(null);
    setUsernameDraft('');
    setPhoneDraft('');
    setAuthMode('signin');
    setIsProfileOpen(false);
  }

  function confirmLogout() {
    Alert.alert('Log out?', 'Are you sure you want to log out of your current account?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: logout },
    ]);
  }

  async function scheduleReminder(task: Task) {
    const startedAt = Date.now();
    const deadline = getNextScheduledDeadline(task, startedAt);
    const reminderAt = Math.max(startedAt + 1000, deadline - getReminderInterval(task, startedAt, deadline) * 0.2);
    if (Platform.OS === 'web' || !Notifications) return { deadline };
    const permissions = await Notifications.getPermissionsAsync();
    const granted = permissions.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return { deadline };
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Task reminder',
        body: `20% of the scheduled time remains for "${task.title}".`,
        data: { taskTitle: task.title },
        sound: 'task-reminder.mpeg',
        vibrate: [0, 500, 250, 500, 250, 700],
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(reminderAt),
        channelId: 'task-reminders-custom',
      },
    });
    return { deadline, notificationId };
  }

  async function toggleReminder(task: Task) {
    const selected = reminderTaskIds.includes(task.id);
    if (selected) {
      Alert.alert('Remove reminder?', `Are you sure you want to remove the reminder for "${task.title}"?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (task.notificationId) await Notifications?.cancelScheduledNotificationAsync(task.notificationId);
            setReminderTaskIds((current) => current.filter((id) => id !== task.id));
            setTasks((current) => current.map((item) => item.id === task.id
              ? { ...item, deadline: undefined, notificationId: undefined }
              : item));
          },
        },
      ]);
      return;
    }

    const reminder = await scheduleReminder(task);
    setReminderTaskIds((current) => [...current, task.id]);
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, ...reminder } : item));
    Alert.alert('Reminder set', `A reminder has been set for "${task.title}".`);
  }

  async function addTask() {
    const title = draft.trim();
    if (!title) return;
    const allottedMinutes = Math.max(1, Number.parseInt(durationDraft, 10) || 30);
    const timerData = timerEnabled ? { allottedMinutes } : {};
    setTasks((current) => [
      {
        id: Date.now().toString(),
        title,
        description: descriptionDraft.trim(),
        project: taskProject,
        due: 'Today',
        frequency,
        weekdays: frequency === 'Several times weekly' || frequency === 'Weekly' ? selectedWeekdays : undefined,
        scheduledDate: frequency === 'Once' || frequency === 'Monthly' ? scheduledDate.trim() : undefined,
        scheduledTime: scheduledTime.trim(),
        done: false,
        accent: '#F0704F',
        ...timerData,
      },
      ...current,
    ]);
    setDraft('');
    setDescriptionDraft('');
    setDurationDraft('30');
    setTimerEnabled(false);
    setFrequency('Once');
    setSelectedWeekdays([]);
    setScheduledDate('');
    setScheduledTime('');
    setTaskProject(projectMode);
    setIsCreating(false);
    setIsProfileOpen(false);
  }

  async function startTaskTimer(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (!task?.allottedMinutes || task.startedAt) return;
    const startedAt = Date.now();
    const reminder = task.notificationId
      ? { deadline: task.deadline }
      : reminderTaskIds.includes(id)
      ? await scheduleReminder(task)
      : { deadline: getNextScheduledDeadline(task, startedAt) };
    setTasks((current) => current.map((item) => item.id === id ? { ...item, startedAt, ...reminder } : item));
  }

  async function toggleTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    if (task.notificationId) await Notifications?.cancelScheduledNotificationAsync(task.notificationId);
    if (task.done) {
      setTasks((current) => current.map((item) => (item.id === id ? { ...item, done: false, deadline: undefined, notificationId: undefined, startedAt: undefined } : item)));
      return;
    }
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, done: true, deadline: undefined, notificationId: undefined } : item)));
  }

  async function removeTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (task?.notificationId) await Notifications?.cancelScheduledNotificationAsync(task.notificationId);
    setTasks((current) => current.filter((task) => task.id !== id));
    setMenuTaskId(null);
  }

  function refreshTask(id: string) {
    setTasks((current) => current.map((item) => item.id === id
      ? { ...item, done: false, deadline: undefined, notificationId: undefined, startedAt: undefined }
      : item));
    setMenuTaskId(null);
  }

  if (!profileLoaded) return null;

  if (username === null || phoneNumber === null) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.profilePage}>
            <Text style={styles.profileEyebrow}>WELCOME TO TASKFLOW</Text>
            <Text style={styles.profileTitle}>{authMode === 'signin' ? 'Welcome back.' : 'Create your account.'}</Text>
            <Text style={styles.profileSubtitle}>{authMode === 'signin' ? 'Sign in to continue managing your tasks.' : 'Create an account to start organizing your tasks.'}</Text>
            <View style={styles.authOptions}>
              <TouchableOpacity onPress={() => setAuthMode('signin')} style={[styles.authOption, authMode === 'signin' && styles.authOptionActive]}>
                <Text style={[styles.authOptionText, authMode === 'signin' && styles.authOptionTextActive]}>Sign in</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setAuthMode('create')} style={[styles.authOption, authMode === 'create' && styles.authOptionActive]}>
                <Text style={[styles.authOptionText, authMode === 'create' && styles.authOptionTextActive]}>Create account</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.fieldLabel}>USER NAME</Text>
            <TextInput autoFocus value={usernameDraft} onChangeText={setUsernameDraft} placeholder="4 letters or numbers" placeholderTextColor="#9BA09A" maxLength={4} autoCapitalize="none" style={styles.taskInput} />
            <Text style={styles.fieldLabel}>PHONE NUMBER</Text>
            <TextInput value={phoneDraft} onChangeText={setPhoneDraft} placeholder="9 digit number" placeholderTextColor="#9BA09A" keyboardType="number-pad" maxLength={9} style={styles.taskInput} onSubmitEditing={saveProfile} />
            <TouchableOpacity onPress={saveProfile} disabled={!validProfileDetails} style={[styles.saveButton, !validProfileDetails && styles.saveButtonDisabled]}>
              <Text style={styles.saveButtonText}>{authMode === 'signin' ? 'Sign in' : 'Create account'}</Text>
              <Ionicons name="arrow-forward" size={16} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (isProfileOpen) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.container}>
          <View style={styles.profileHeader}>
            <TouchableOpacity onPress={() => setIsProfileOpen(false)} accessibilityLabel="Go back to dashboard" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color="#000000" />
            </TouchableOpacity>
            <View style={styles.profileAvatar}><Text style={styles.profileAvatarText}>{avatarLabel}</Text></View>
            <View style={styles.profileHeaderCopy}><Text style={styles.profileName}>{username}</Text><Text style={styles.profileTaskCount}>{phoneNumber}  •  {tasks.length} tasks</Text></View>
          </View>
          <View style={styles.profileFilters}>
            {(['Pending', 'Completed', 'Failed', 'All'] as ProfileFilter[]).map((item) => (
              <TouchableOpacity key={item} onPress={() => setProfileFilter(item)} style={[styles.profileFilter, profileFilter === item && styles.profileFilterActive]}>
                <Text style={[styles.profileFilterText, profileFilter === item && styles.profileFilterTextActive]}>{item}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <FlatList
            data={profileTasks}
            keyExtractor={(item) => `profile-${item.id}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<View style={styles.empty}><Ionicons name="checkmark-circle-outline" size={30} color="#7C86FF" /><Text style={styles.emptyTitle}>No {profileFilter.toLowerCase()} tasks</Text></View>}
            renderItem={({ item }) => (
              <View style={[styles.profileTaskRow, item.done && styles.completedCard]}>
                <View style={styles.profileTaskBody}><Text style={[styles.taskTitle, item.done && styles.completedText]}>{item.title}</Text><Text style={styles.profileTaskMeta}>{item.project}  •  {getScheduleLabel(item)}</Text></View>
                <Ionicons name={item.done ? 'checkmark-circle' : isTaskFailed(item, now) ? 'alert-circle' : 'ellipse-outline'} size={17} color={item.done ? '#8B9A6B' : isTaskFailed(item, now) ? '#D85C43' : '#B7BDB6'} />
              </View>
            )}
          />
          <TouchableOpacity onPress={confirmLogout} style={styles.logoutButton}>
            <Ionicons name="log-out-outline" size={16} color={COLORS.danger} />
            <Text style={styles.logoutText}>Log out</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (isReminderOpen) {
    const pendingTasks = tasks.filter((task) => !task.done && !isTaskFailed(task, now));
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.container}>
          <View style={styles.createHeader}>
            <TouchableOpacity onPress={() => setIsReminderOpen(false)} accessibilityLabel="Go back to dashboard" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color="#000000" />
            </TouchableOpacity>
            <Text style={styles.createHeaderTitle}>Reminders</Text>
            <View style={styles.headerSpacer} />
          </View>
          <Text style={styles.createTitle}>Choose task reminders</Text>
          <Text style={styles.createSubtitle}>Selected tasks notify you when 20% of the scheduled time remains.</Text>
          <FlatList
            data={pendingTasks}
            keyExtractor={(item) => `reminder-${item.id}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<View style={styles.empty}><Ionicons name="notifications-off-outline" size={30} color="#7C86FF" /><Text style={styles.emptyTitle}>No pending tasks</Text><Text style={styles.emptyText}>Completed and overdue tasks cannot receive reminders.</Text></View>}
            renderItem={({ item }) => {
              const selected = reminderTaskIds.includes(item.id);
              return (
                <TouchableOpacity onPress={() => toggleReminder(item)} style={styles.reminderTaskRow}>
                  <View style={styles.reminderTaskCopy}><Text style={styles.taskTitle}>{item.title}</Text><Text style={styles.profileTaskMeta}>{item.project}  •  {getScheduleLabel(item)}</Text></View>
                  <View style={[styles.reminderCheck, selected && styles.reminderCheckActive]}>{selected && <Ionicons name="checkmark" size={14} color="#FFFFFF" />}</View>
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (isCreating) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.createHeader}>
            <TouchableOpacity onPress={() => setIsCreating(false)} accessibilityLabel="Go back" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color="#000000" />
            </TouchableOpacity>
            <Text style={styles.createHeaderTitle}>New task</Text>
            <View style={styles.headerSpacer} />
          </View>

          <ScrollView
            style={styles.createScroll}
            contentContainerStyle={styles.createContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.createEyebrow}>ADD TO YOUR LIST</Text>
            <Text style={styles.createTitle}>What needs doing?</Text>
            <Text style={styles.createSubtitle}>Keep it simple. You can add a timer when this task needs one.</Text>

            <Text style={styles.fieldLabel}>TASK LIST</Text>
            <View style={styles.projectOptions}>
              {(['Personal', 'Work'] as Project[]).map((option) => (
                <TouchableOpacity key={option} onPress={() => setTaskProject(option)} style={[styles.projectOption, taskProject === option && styles.projectOptionActive]}>
                  <Ionicons name={option === 'Personal' ? 'person-outline' : 'briefcase-outline'} size={15} color={taskProject === option ? '#1A73E8' : '#77807A'} />
                  <Text style={[styles.projectOptionText, taskProject === option && styles.projectOptionTextActive]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.fieldLabel}>TASK NAME</Text>
            <TextInput
              autoFocus
              value={draft}
              onChangeText={setDraft}
              placeholder="e.g. Call the dentist"
              placeholderTextColor="#9BA09A"
              style={styles.taskInput}
            />

            <Text style={styles.fieldLabel}>DESCRIPTION</Text>
            <TextInput
              value={descriptionDraft}
              onChangeText={setDescriptionDraft}
              placeholder="Add details for this task"
              placeholderTextColor="#9BA09A"
              multiline
              textAlignVertical="top"
              style={styles.descriptionInput}
            />

            <View style={styles.timerSetting}>
              <View style={styles.timerCopy}>
                <Ionicons name="timer-outline" size={19} color="#6D5DF6" />
                <View>
                  <Text style={styles.timerTitle}>Add a timer</Text>
                  <Text style={styles.timerSubtitle}>Get a reminder when time is up</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setTimerEnabled((enabled) => !enabled)}
                accessibilityRole="switch"
                accessibilityState={{ checked: timerEnabled }}
                style={[styles.toggle, timerEnabled && styles.toggleActive]}
              >
                <View style={[styles.toggleKnob, timerEnabled && styles.toggleKnobActive]} />
              </TouchableOpacity>
            </View>

            {timerEnabled && (
              <View style={styles.durationField}>
                <Text style={styles.fieldLabel}>TIME LIMIT</Text>
                <View style={styles.durationRow}>
                  <TextInput value={durationDraft} onChangeText={setDurationDraft} keyboardType="number-pad" maxLength={4} style={styles.durationLargeInput} />
                  <Text style={styles.durationUnit}>minutes</Text>
                </View>
              </View>
            )}

            <Text style={styles.fieldLabel}>REPEAT</Text>
            <View style={styles.frequencyOptions}>
              {frequencyOptions.map((option) => (
                <TouchableOpacity key={option} onPress={() => { setFrequency(option); if (option !== 'Several times weekly') setSelectedWeekdays([]); }} style={[styles.frequencyOption, frequency === option && styles.frequencyOptionActive]}>
                  <Text style={[styles.frequencyOptionText, frequency === option && styles.frequencyOptionTextActive]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {(frequency === 'Several times weekly' || frequency === 'Weekly') && (
              <View style={styles.weekdayField}>
              <Text style={styles.fieldLabel}>{frequency === 'Weekly' ? 'WHICH DAY?' : 'WHICH DAYS?'}</Text>
                <View style={styles.weekdayOptions}>
                  {weekdayOptions.map((day) => {
                    const selected = selectedWeekdays.includes(day);
                    return (
                      <TouchableOpacity key={day} onPress={() => setSelectedWeekdays((current) => {
                                                if (frequency === 'Weekly') return selected ? [] : [day];
                                                return selected ? current.filter((item) => item !== day) : [...current, day];
                                              })} style={[styles.weekdayOption, selected && styles.weekdayOptionActive]}>
                        <Text style={[styles.weekdayText, selected && styles.weekdayTextActive]}>{day}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {(frequency === 'Once' || frequency === 'Monthly' || frequency === 'Daily' || frequency === 'Weekly' || frequency === 'Several times weekly') && (
              <View style={styles.oneTimeFields}>
                <Text style={styles.fieldLabel}>{frequency === 'Once' ? 'WHEN SHOULD IT HAPPEN?' : frequency === 'Monthly' ? 'WHEN EACH MONTH?' : 'TIME OF DAY'}</Text>
                <View style={styles.dateTimeRow}>
                  {(frequency === 'Once' || frequency === 'Monthly') && <TextInput value={scheduledDate} onChangeText={setScheduledDate} placeholder={frequency === 'Monthly' ? 'Day 1-31' : 'YYYY-MM-DD'} placeholderTextColor="#9BA09A" style={styles.dateTimeInput} />}
                  <TextInput value={scheduledTime} onChangeText={setScheduledTime} placeholder="HH:MM" placeholderTextColor="#9BA09A" keyboardType="numbers-and-punctuation" style={[styles.timeInput, frequency !== 'Once' && frequency !== 'Monthly' && styles.timeInputFull]} />
                </View>
              </View>
            )}

            <TouchableOpacity onPress={addTask} disabled={!draft.trim() || !scheduledTime.trim() || ((frequency === 'Weekly' || frequency === 'Several times weekly') && selectedWeekdays.length === 0) || ((frequency === 'Once' || frequency === 'Monthly') && !scheduledDate.trim())} style={[styles.saveButton, (!draft.trim() || !scheduledTime.trim() || ((frequency === 'Weekly' || frequency === 'Several times weekly') && selectedWeekdays.length === 0) || ((frequency === 'Once' || frequency === 'Monthly') && !scheduledDate.trim())) && styles.saveButtonDisabled]}>
              <Text style={styles.saveButtonText}>Create task</Text>
              <Ionicons name="arrow-forward" size={16} color="#FFFFFF" />
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (taskPage) {
    const pageTasks = tasks.filter((task) => task.done === (taskPage === 'completed'));
    const pageTitle = taskPage === 'completed' ? 'Completed tasks' : 'Ongoing tasks';
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.container}>
          <View style={styles.createHeader}>
            <TouchableOpacity onPress={() => setTaskPage(null)} accessibilityLabel="Go back to dashboard" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color="#000000" />
            </TouchableOpacity>
            <Text style={styles.createHeaderTitle}>{pageTitle}</Text>
            <View style={styles.headerSpacer} />
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dashboardContent}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{pageTitle}</Text>
              <Text style={styles.taskCount}>{pageTasks.length} total</Text>
            </View>
            {pageTasks.length === 0 ? (
              <View style={styles.empty}><Ionicons name={taskPage === 'completed' ? 'checkmark-circle-outline' : 'list-outline'} size={30} color="#7C86FF" /><Text style={styles.emptyTitle}>Nothing here yet</Text><Text style={styles.emptyText}>{taskPage === 'completed' ? 'Completed tasks will appear here.' : 'Ongoing tasks will appear here.'}</Text></View>
            ) : pageTasks.map((item) => (
              <View key={item.id} style={styles.taskItem}>
                  <View style={[styles.taskCard, item.done && styles.completedCard]}>
                  <TouchableOpacity onPress={() => toggleTask(item.id)} style={[styles.checkbox, item.done && styles.checked]}>
                    {item.done && <Ionicons name="checkmark" size={13} color="#FFFFFF" />}
                  </TouchableOpacity>
                  <View style={styles.taskBody}>
                    <Text style={[styles.taskTitle, styles.taskCardTitle, item.done && styles.completedText]}>{item.title}</Text>
                    <View style={styles.metaRow}><Text style={[styles.meta, styles.taskCardMeta]}>{item.project}</Text><Text style={[styles.metaDivider, styles.taskCardMeta]}>•</Text><Text style={[styles.meta, styles.taskCardMeta]}>{getScheduleLabel(item)}</Text></View>
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          style={styles.dashboardScroll}
          contentContainerStyle={styles.dashboardContent}
          showsVerticalScrollIndicator={false}
          scrollEnabled
          bounces
          alwaysBounceVertical
          overScrollMode="always"
          contentInsetAdjustmentBehavior="automatic"
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
        <View style={styles.header}>
          <View style={styles.headerIconActions}>
            <TouchableOpacity onPress={() => setIsReminderOpen(true)} accessibilityLabel="Open reminders" style={styles.reminderFloatingButton}>
              <Ionicons name="notifications-outline" size={15} color="#000000" />
            </TouchableOpacity>
            <Animated.View
              {...addButtonPanResponder.panHandlers}
              style={[styles.addFloatingButton, { transform: addButtonPosition.getTranslateTransform() }]}
            >
              <TouchableOpacity onPress={() => { setTaskProject(projectMode); setIsCreating(true); }} accessibilityLabel="Create new task" style={styles.addFloatingButtonTouchTarget}>
                <Ionicons name="add" size={20} color="#000000" />
              </TouchableOpacity>
            </Animated.View>
          </View>
          <TouchableOpacity onPress={() => setIsProfileOpen(true)} accessibilityLabel="Open profile" style={styles.dashboardAvatar}>
            <Text style={styles.dashboardAvatarText}>{avatarLabel}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.projectTabs}>
          {(['Personal', 'Work'] as Project[]).map((option) => (
            <TouchableOpacity key={option} onPress={() => setProjectMode(option)} style={[styles.projectTab, projectMode === option && styles.projectTabActive]}>
              <Ionicons name={option === 'Personal' ? 'person-outline' : 'briefcase-outline'} size={14} color="#000000" />
              <Text style={[styles.projectTabText, projectMode === option && styles.projectTabTextActive]}>{option}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your tasks</Text>
            <Text style={styles.taskCount}>{projectTasks.length} total</Text>
        </View>
        {visibleTasks.length === 0 ? (
          <View style={styles.empty}><Ionicons name="checkmark-circle-outline" size={30} color="#7C86FF" /><Text style={styles.emptyTitle}>Nothing here yet</Text><Text style={styles.emptyText}>Add a task and keep the momentum going.</Text></View>
        ) : visibleTasks.map((item) => (
            <View key={item.id} style={styles.taskItem}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => setExpandedTaskId((current) => current === item.id ? null : item.id)} style={[styles.taskCard, item.done && styles.completedCard]}>
                <TouchableOpacity onPress={() => toggleTask(item.id)} style={[styles.checkbox, item.done && styles.checked]}>
                  {item.done && <Ionicons name="checkmark" size={13} color="#FFFFFF" />}
                </TouchableOpacity>
                <View style={styles.taskBody}>
                  <Text style={[styles.taskTitle, styles.taskCardTitle, item.done && styles.completedText]}>{item.title}</Text>
                  <View style={styles.metaRow}><Text style={[styles.meta, styles.taskCardMeta]}>{item.project}</Text><Text style={[styles.metaDivider, styles.taskCardMeta]}>•</Text><Text style={[styles.meta, styles.taskCardMeta]}>{getScheduleLabel(item)}</Text>{item.allottedMinutes !== undefined && <><Text style={[styles.metaDivider, styles.taskCardMeta]}>•</Text><Text style={[styles.meta, styles.taskCardMeta, item.deadline !== undefined && now >= item.deadline && !item.done ? styles.overdueMeta : undefined]}>{item.deadline !== undefined && now >= item.deadline && !item.done ? 'Overdue' : `${item.allottedMinutes} min`}</Text></>}</View>
                  {expandedTaskId === item.id && <View style={styles.taskDetails}>
                    <Text style={styles.descriptionText}>{item.description || 'No description added.'}</Text>
                    {item.allottedMinutes !== undefined && !item.done && <TouchableOpacity onPress={() => startTaskTimer(item.id)} disabled={item.startedAt !== undefined} style={[styles.startButton, item.startedAt !== undefined && styles.startButtonDisabled]}>
                      <Ionicons name={item.startedAt !== undefined ? 'time-outline' : 'play'} size={14} color="#FFFFFF" />
                      <Text style={styles.startButtonText}>{item.startedAt !== undefined ? `${Math.max(0, Math.ceil(((item.deadline ?? now) - now) / 60000))} min left` : 'Start task'}</Text>
                    </TouchableOpacity>}
                  </View>}
                </View>
                <TouchableOpacity onPress={() => setMenuTaskId((current) => current === item.id ? null : item.id)} accessibilityLabel={`Task actions for ${item.title}`} style={styles.moreButton}>
                  <Ionicons name="ellipsis-horizontal" size={17} color="#9BA09A" />
                </TouchableOpacity>
              </TouchableOpacity>
              {menuTaskId === item.id && <View style={styles.taskMenu}>
                  <TouchableOpacity onPress={() => removeTask(item.id)} style={styles.menuAction}>
                    <Ionicons name="trash-outline" size={14} color="#E14F3D" />
                    <Text style={styles.deleteMenuText}>Delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => refreshTask(item.id)} disabled={!item.done} style={[styles.menuAction, !item.done && styles.menuActionDisabled]}>
                    <Ionicons name="refresh-outline" size={14} color={item.done ? '#3E5141' : '#B7BDB6'} />
                    <Text style={[styles.menuText, !item.done && styles.menuTextDisabled]}>Refresh</Text>
                  </TouchableOpacity>
              </View>}
            </View>
          ))}
        </ScrollView>
        <View style={styles.dashboardTabs}>
          <TouchableOpacity onPress={() => setTaskPage('ongoing')} style={styles.dashboardTab}>
            <Ionicons name="list-outline" size={15} color={COLORS.textOnDarkMuted} />
            <Text style={styles.dashboardTabText}>Ongoing</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setTaskPage('completed')} style={styles.dashboardTab}>
            <Ionicons name="checkmark-circle-outline" size={15} color={COLORS.textOnDarkMuted} />
            <Text style={styles.dashboardTabText}>Completed</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <CrashBoundary>
      <TaskflowApp />
    </CrashBoundary>
  );
}

const COLORS = {
  bg: '#FFFFFF',
  bgElevated: '#181B22',
  surface: '#181B22',
  surfaceMuted: '#202530',
  surfaceSubtle: '#2A303B',
  border: '#2F3644',
  borderStrong: '#3E475A',
  textOnDark: '#000000',
  textOnDarkMuted: '#000000',
  textPrimary: '#000000',
  textSecondary: '#000000',
  textMuted: '#000000',
  accent: '#6D5DF6',
  accentSoft: '#EDEAFF',
  accentDeep: '#5645D9',
  coral: '#F0704F',
  coralSoft: '#FDE4DC',
  success: '#1FA971',
  successSoft: '#E1F5EB',
  warning: '#E6A63A',
  danger: '#E14F3D',
  dangerSoft: '#FBE3E0',
};

const shadowSm = {
  shadowColor: '#12141A',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 6,
  elevation: 2,
};

const shadowMd = {
  shadowColor: '#12141A',
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.12,
  shadowRadius: 18,
  elevation: 5,
};

const styles = StyleSheet.create({
  crashScreen: { flex: 1, backgroundColor: '#1A0E0C', padding: 24, paddingTop: 72 },
  crashTitle: { color: '#FF9A8A', fontSize: 28, fontWeight: '800', marginBottom: 12 },
  crashMessage: { color: '#000000', fontSize: 17, marginBottom: 24 },
  crashLog: { color: '#FFC9BE', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
  safeArea: { flex: 1, backgroundColor: COLORS.bg },
  container: { flex: 1, paddingHorizontal: 22 },
  dashboardScroll: { flex: 1 },
  dashboardContent: { flexGrow: 1, justifyContent: 'flex-end', paddingBottom: 110 },
  profilePage: { flex: 1, justifyContent: 'center', paddingBottom: 80 },
  profileEyebrow: { color: COLORS.coral, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12 },
  profileTitle: { color: COLORS.textOnDark, fontSize: 30, fontWeight: '800', letterSpacing: -0.4 },
  profileSubtitle: { color: COLORS.textOnDarkMuted, fontSize: 15, lineHeight: 21, marginTop: 10, marginBottom: 30 },
  authOptions: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  authOption: { flex: 1, alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, paddingVertical: 11 },
  authOptionActive: { backgroundColor: COLORS.accent },
  authOptionText: { color: COLORS.textOnDarkMuted, fontSize: 13, fontWeight: '700' },
  authOptionTextActive: { color: '#000000' },
  profileHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 18, paddingBottom: 26 },
  profileAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center', marginLeft: 14, borderWidth: 1, borderColor: '#C5C7E6' },
  profileAvatarText: { color: '#000000', fontSize: 18, fontWeight: '800' },
  profileHeaderCopy: { marginLeft: 13 },
  profileName: { color: COLORS.textOnDark, fontSize: 22, fontWeight: '800' },
  profileTaskCount: { color: COLORS.textOnDarkMuted, fontSize: 13, marginTop: 3 },
  profileFilters: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  profileFilter: { flex: 1, alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, paddingVertical: 10 },
  profileFilterActive: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#000000' },
  profileFilterText: { color: COLORS.textOnDarkMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  profileFilterTextActive: { color: '#000000' },
  profileTaskRow: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#000000' },
  profileTaskBody: { flex: 1, marginHorizontal: 12 },
  profileTaskMeta: { color: COLORS.textOnDarkMuted, fontSize: 12, marginTop: 6 },
  logoutButton: { alignSelf: 'stretch', minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#000000', marginTop: 12, marginBottom: 12 },
  logoutText: { color: COLORS.danger, fontSize: 16, fontWeight: '800' },
  reminderTaskRow: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#000000' },
  reminderTaskCopy: { flex: 1 },
  reminderCheck: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: '#3B4150', justifyContent: 'center', alignItems: 'center' },
  reminderCheckActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', width: '100%', paddingTop: 24, paddingBottom: 26 },
  headerIconActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 10 },
  headerCopy: { paddingRight: 12, marginTop: 16 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  createButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.coral, justifyContent: 'center', alignItems: 'center' },
  eyebrow: { color: COLORS.coral, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 10 },
  title: { color: COLORS.textOnDark, fontSize: 29, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: COLORS.textOnDarkMuted, fontSize: 14, marginTop: 8 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: COLORS.accentSoft, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: COLORS.accentDeep, fontSize: 15, fontWeight: '800' },
  dashboardAvatar: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  dashboardAvatarText: { color: '#000000', fontSize: 16, fontWeight: '800' },
  summary: { backgroundColor: COLORS.accent, borderRadius: 20, padding: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, ...shadowMd, shadowColor: COLORS.accent, shadowOpacity: 0.35 },
  summaryLabel: { color: '#000000', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  summaryNumber: { color: '#000000', fontSize: 34, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  summaryTail: { color: '#000000', fontSize: 16, fontWeight: '500' },
  projectTabs: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  projectTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: '#000000', paddingVertical: 11 },
  projectTabActive: { backgroundColor: '#FFFFFF' },
  projectTabText: { color: COLORS.textOnDarkMuted, fontSize: 13, fontWeight: '600' },
  projectTabTextActive: { color: '#000000', fontWeight: '700' },
  progressRing: { width: 60, height: 60, borderRadius: 30, borderWidth: 4, borderColor: 'rgba(255,255,255,0.35)', backgroundColor: 'rgba(255,255,255,0.12)', justifyContent: 'center', alignItems: 'center' },
  progressText: { color: '#000000', fontSize: 14, fontWeight: '800' },
  createHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 20, paddingBottom: 28 },
  backButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  createHeaderTitle: { flex: 1, textAlign: 'center', color: COLORS.textOnDark, fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 42 },
  createScroll: { flex: 1 },
  createContent: { paddingTop: 22, paddingBottom: 40 },
  createEyebrow: { color: COLORS.coral, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 10 },
  createTitle: { color: COLORS.textOnDark, fontSize: 29, fontWeight: '800', letterSpacing: -0.4 },
  createSubtitle: { color: COLORS.textOnDarkMuted, fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 34 },
  projectOptions: { flexDirection: 'row', gap: 10, marginBottom: 26 },
  projectOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', backgroundColor: '#FFFFFF', paddingVertical: 14 },
  projectOptionActive: { backgroundColor: COLORS.accentSoft, borderColor: COLORS.accent },
  projectOptionText: { color: COLORS.textOnDarkMuted, fontSize: 14, fontWeight: '600' },
  projectOptionTextActive: { color: COLORS.accentDeep, fontWeight: '700' },
  fieldLabel: { color: COLORS.coral, fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginBottom: 10, marginTop: 4 },
  taskInput: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', color: COLORS.textOnDark, fontSize: 17, paddingHorizontal: 16, paddingVertical: 16, marginBottom: 4 },
  timerSetting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1.5, borderColor: '#C5C7E6', marginTop: 20, padding: 16 },
  timerCopy: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  timerTitle: { color: COLORS.textOnDark, fontSize: 15, fontWeight: '700' },
  timerSubtitle: { color: COLORS.textOnDarkMuted, fontSize: 12, marginTop: 4 },
  toggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: '#2A2F3B', padding: 3, justifyContent: 'center' },
  toggleActive: { backgroundColor: COLORS.accent },
  toggleKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF' },
  toggleKnobActive: { alignSelf: 'flex-end' },
  durationField: { marginTop: 22 },
  durationRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', paddingHorizontal: 16 },
  durationLargeInput: { color: COLORS.textOnDark, fontSize: 20, fontWeight: '800', paddingVertical: 15, width: 70 },
  durationUnit: { color: COLORS.textOnDarkMuted, fontSize: 14 },
  frequencyOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  frequencyOption: { borderRadius: 18, borderWidth: 1.5, borderColor: '#C5C7E6', backgroundColor: '#FFFFFF', paddingHorizontal: 14, paddingVertical: 10 },
  frequencyOptionActive: { backgroundColor: COLORS.accentSoft, borderColor: COLORS.accent },
  frequencyOptionText: { color: COLORS.textOnDarkMuted, fontSize: 13, fontWeight: '600' },
  frequencyOptionTextActive: { color: COLORS.accentDeep, fontWeight: '700' },
  weekdayField: { marginTop: 24 },
  weekdayOptions: { flexDirection: 'row', justifyContent: 'space-between' },
  weekdayOption: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: '#C5C7E6', backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  weekdayOptionActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  weekdayText: { color: COLORS.textOnDarkMuted, fontSize: 11, fontWeight: '700' },
  weekdayTextActive: { color: '#000000' },
  oneTimeFields: { marginTop: 24 },
  dateTimeRow: { flexDirection: 'row', gap: 10 },
  dateTimeInput: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', color: COLORS.textOnDark, fontSize: 15, paddingHorizontal: 14, paddingVertical: 16 },
  timeInput: { width: 108, backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', color: COLORS.textOnDark, fontSize: 15, paddingHorizontal: 14, paddingVertical: 16 },
  timeInputFull: { flex: 1, width: undefined },
  descriptionInput: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1.5, borderColor: '#C5C7E6', color: COLORS.textOnDark, fontSize: 15, minHeight: 96, paddingHorizontal: 14, paddingVertical: 14, marginBottom: 24, lineHeight: 21 },
  saveButton: { backgroundColor: COLORS.coral, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 34, minHeight: 58, ...shadowMd, shadowColor: COLORS.coral, shadowOpacity: 0.35 },
  saveButtonDisabled: { opacity: 0.4, shadowOpacity: 0 },
  saveButtonText: { color: '#000000', fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 14 },
  sectionTitle: { color: COLORS.textOnDark, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  taskCount: { color: COLORS.textOnDarkMuted, fontSize: 13 },
  list: { paddingBottom: 18 },
  dashboardTabs: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 12, padding: 8, backgroundColor: COLORS.bg, borderTopWidth: 1, borderTopColor: '#C2E0EE' },
  dashboardTab: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#000000' },
  dashboardTabActive: { backgroundColor: COLORS.accent },
  dashboardTabText: { color: COLORS.textOnDarkMuted, fontSize: 13, fontWeight: '700' },
  dashboardTabTextActive: { color: '#000000' },
  reminderFloatingButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  addFloatingButton: { width: 48, height: 48 },
  addFloatingButtonTouchTarget: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  taskItem: { marginBottom: 10 },
  taskCard: { backgroundColor: COLORS.bg, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#C5C7E6', ...shadowSm },
  taskCardTitle: { color: '#000000' },
  taskCardMeta: { color: '#000000' },
  completedCard: { backgroundColor: COLORS.bg, shadowOpacity: 0, elevation: 0 },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: COLORS.borderStrong, justifyContent: 'center', alignItems: 'center', marginRight: 13 },
  checked: { backgroundColor: COLORS.success, borderColor: COLORS.success },
  taskBody: { flex: 1 },
  taskTitle: { color: '#000000', fontSize: 15, fontWeight: '700' },
  taskDetails: { borderTopWidth: 1, borderTopColor: COLORS.border, marginTop: 12, paddingTop: 12 },
  descriptionText: { color: '#000000', fontSize: 13, lineHeight: 19, marginBottom: 12 },
  startButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.coral, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  startButtonDisabled: { backgroundColor: COLORS.success },
  startButtonText: { color: '#000000', fontSize: 12, fontWeight: '800' },
  completedText: { color: COLORS.textMuted, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  meta: { color: '#000000', fontSize: 12 },
  overdueMeta: { color: COLORS.danger, fontWeight: '800' },
  metaDivider: { color: COLORS.border, fontSize: 12, marginHorizontal: 7 },
  moreButton: { paddingLeft: 10, paddingVertical: 7 },
  taskMenu: { width: '100%', backgroundColor: COLORS.bgElevated, borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, paddingVertical: 4, marginTop: -2, ...shadowSm },
  menuAction: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 11 },
  menuActionDisabled: { opacity: 0.6 },
  menuText: { color: '#000000', fontSize: 13, fontWeight: '600' },
  menuTextDisabled: { color: COLORS.textMuted },
  deleteMenuText: { color: COLORS.danger, fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 56 },
  emptyTitle: { color: COLORS.textOnDark, fontSize: 17, fontWeight: '700', marginTop: 14 },
  emptyText: { color: COLORS.textOnDarkMuted, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
});
