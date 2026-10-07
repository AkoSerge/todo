import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type * as DateTimePickerModule from '@react-native-community/datetimepicker';
import type * as GoogleSignInModule from '@react-native-google-signin/google-signin';
import type * as NotificationsModule from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  PanResponder,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  frequencyOptions,
  getNextScheduledDeadline,
  getReminderInterval,
  getScheduleLabel,
  getOverdueGraceLeft,
  isTaskFailed,
  FAIL_GRACE_MS,
  type AuthMode,
  type Frequency,
  type ProfileFilter,
  type Project,
  type Task,
  type Weekday,
  validPhonePattern,
  validUsernamePattern,
  weekdayOptions,
} from './pages';
import LandingPage from './landing';
import { Palette, ThemeProvider, useTheme } from './theme';
import { ToastProvider, useToast } from './toast';
import { googleUserId, localUserId, openSession, saveTasks, type SessionMode, type UserRecord } from './api';
import { ALERTS_VERSION, DEFAULT_REMINDER_PERCENT, formatMinutes, planTaskNotifications } from './notifications';

const Notifications: typeof NotificationsModule | null = Constants.appOwnership === 'expo'
  ? null
  : require('expo-notifications');

// Google Sign-In is a native module, so it only exists in a dev/production build, not Expo Go.
// Native date/time picker. Not available on web, where plain text fields are used instead.
// Wrapped in try so an older installed build without the native module still starts.
const DateTimePicker: typeof DateTimePickerModule | null = (() => {
  if (Platform.OS === 'web') return null;
  try {
    return require('@react-native-community/datetimepicker');
  } catch {
    return null;
  }
})();

const pad = (value: number) => String(value).padStart(2, '0');

// Android channels for task alerts. They ring like an alarm: played on the alarm stream (alarm volume,
// heard even when the phone is on silent/vibrate) and allowed to break through Do Not Disturb once the
// user enables "Override Do Not Disturb". The user can change the sound from Profile > Alarm sound.
// - ALERT: the app's 5-second alarm tone (assets/alert_tone.mp3), used once the installed build contains it.
// - DEVICE: the phone's default sound on the alarm stream, used by older builds without the tone.
const ALERT_CHANNEL_ID = 'task-alarms-alert-tone';
const DEVICE_CHANNEL_ID = 'task-alarms-default-sound';
// Earlier channels (notification-style sounds); removed so only the alarm channel shows in settings.
const OLD_CHANNEL_IDS = ['task-reminders-custom', 'task-alerts-love-sms', 'task-alerts-sms-tone', 'task-alerts', 'task-alerts-alert-tone', 'task-alerts-device-sound'];
const ALERT_TONE = 'alert_tone.mp3';

// Android fixes a channel's sound when it's created, and a missing sound file would make the channel
// silent forever. So the alert channel is only created after a throwaway probe channel proves the
// tone is in the installed app; otherwise the default-sound channel is used.
async function setUpNotificationChannel(notifications: typeof NotificationsModule) {
  const channelOptions = {
    name: 'Task alarms',
    description: 'Reminders, deadlines and "Time\'s up" alerts for your tasks',
    importance: notifications.AndroidImportance.MAX,
    bypassDnd: true,
    lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
    enableVibrate: true,
    vibrationPattern: [0, 800, 400, 800, 400, 800, 400, 800, 400, 800],
    audioAttributes: {
      usage: notifications.AndroidAudioUsage.ALARM,
      contentType: notifications.AndroidAudioContentType.SONIFICATION,
      flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
    },
  };
  const existing = await notifications.getNotificationChannelAsync(ALERT_CHANNEL_ID);
  if (existing?.sound) return ALERT_CHANNEL_ID;

  const probeId = `alert-tone-probe-${Date.now()}`;
  await notifications.setNotificationChannelAsync(probeId, { ...channelOptions, sound: ALERT_TONE });
  const probe = await notifications.getNotificationChannelAsync(probeId);
  await notifications.deleteNotificationChannelAsync(probeId);
  if (probe?.sound) {
    await notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, { ...channelOptions, sound: ALERT_TONE });
    return ALERT_CHANNEL_ID;
  }
  await notifications.setNotificationChannelAsync(DEVICE_CHANNEL_ID, channelOptions);
  return DEVICE_CHANNEL_ID;
}

const GoogleAuth: typeof GoogleSignInModule | null = Constants.appOwnership === 'expo' || Platform.OS === 'web'
  ? null
  : require('@react-native-google-signin/google-signin');

// Set in .env. Must be a Web application client ID (leave empty if unused).
const googleWebClientId: string | undefined = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined;
GoogleAuth?.GoogleSignin.configure({ webClientId: googleWebClientId });

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
        <SafeAreaView style={crashStyles.crashScreen}>
          <Text style={crashStyles.crashTitle}>Todo crashed</Text>
          <Text style={crashStyles.crashMessage}>{this.state.error.message || 'Unknown JavaScript error'}</Text>
          <Text selectable style={crashStyles.crashLog}>{this.state.stack ?? this.state.error.toString()}</Text>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

function TaskflowApp({ initialAuthMode, onBack }: { initialAuthMode: AuthMode; onBack?: () => void }) {
  const { colors, mode, toggleTheme } = useTheme();
  const showToast = useToast();
  const [channelId, setChannelId] = useState<string | null>(Platform.OS === 'android' ? null : DEVICE_CHANNEL_ID);
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [tasksSynced, setTasksSynced] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [phoneDraft, setPhoneDraft] = useState('');
  const [statusTab, setStatusTab] = useState<'ongoing' | 'completed'>('ongoing');
  const [projectFilter, setProjectFilter] = useState<'All' | Project>('All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [taskProject, setTaskProject] = useState<Project>('Personal');
  const [draft, setDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [durationDraft, setDurationDraft] = useState('30');
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>('Once');
  const [selectedWeekdays, setSelectedWeekdays] = useState<Weekday[]>([]);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Set when a failed task is being rescheduled from the Profile screen; the editor returns there.
  const [isReschedulingFailed, setIsReschedulingFailed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isReminderOpen, setIsReminderOpen] = useState(false);
  const defaultReminderPercent = DEFAULT_REMINDER_PERCENT;
  const [reminderChoice, setReminderChoice] = useState<'auto' | 'every20' | 'custom' | number>('auto');
  const [customReminderDraft, setCustomReminderDraft] = useState('');
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
    if (initialAuthMode === 'create') {
      setProfileLoaded(true);
      return;
    }
    AsyncStorage.multiGet(['taskflow.username', 'taskflow.phone', 'taskflow.userId']).then(async ([[, savedUsername], [, savedPhone], [, savedUserId]]) => {
      setUsernameDraft(savedUsername ?? '');
      setPhoneDraft(savedPhone ?? '');
      if (savedUsername !== null && savedPhone !== null) {
        const id = savedUserId ?? localUserId(savedUsername, savedPhone);
        try {
          applyUser(await openSession(id, 'upsert', { username: savedUsername, phone: savedPhone }));
        } catch (error) {
          // Stay signed out rather than showing (and later overwriting) an empty task list.
          Alert.alert('Could not load your tasks', error instanceof Error ? error.message : 'Please sign in again.');
        }
      }
      setProfileLoaded(true);
    });
  }, []);

  // Save the signed-in user's tasks to the database shortly after they change.
  useEffect(() => {
    if (!userId || !tasksSynced) return;
    const timer = setTimeout(() => {
      saveTasks(userId, tasks).catch((error) => console.warn('Could not save tasks', error));
    }, 600);
    return () => clearTimeout(timer);
  }, [tasks, tasksSynced, userId]);

  useEffect(() => {
    if (Platform.OS === 'web' || !Notifications) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
    });
    for (const oldChannel of OLD_CHANNEL_IDS) Notifications.deleteNotificationChannelAsync(oldChannel).catch(() => undefined);
    if (Platform.OS === 'android') {
      setUpNotificationChannel(Notifications)
        .then(setChannelId)
        .catch((error) => {
          console.warn('Could not set up the alert tone channel', error);
          setChannelId(DEVICE_CHANNEL_ID);
        });
    }

    // Every reminder also shows an alert: when it arrives while the app is open, or when it is tapped.
    const alerted = new Set<string>();
    const showAlert = (notification: NotificationsModule.Notification) => {
      const { identifier, content } = notification.request;
      if (alerted.has(identifier)) return;
      alerted.add(identifier);
      Alert.alert(content.title ?? 'Todo', content.body ?? '');
    };
    const received = Notifications.addNotificationReceivedListener(showAlert);
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => showAlert(response.notification));
    return () => {
      received.remove();
      tapped.remove();
    };
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

  // Failed tasks (not completed within 10 minutes of the deadline) leave the task list; they stay under Profile > Failed.
  const visibleTasks = useMemo(() => tasks.filter((task) =>
    task.done === (statusTab === 'completed')
    && !isTaskFailed(task, now)
    && (projectFilter === 'All' || task.project === projectFilter),
  ), [now, projectFilter, statusTab, tasks]);
  const defaultTaskProject: Project = projectFilter === 'All' ? 'Personal' : projectFilter;
  const [iosPicker, setIosPicker] = useState<'date' | 'time' | null>(null);

  // Current value for the picker, built from the saved "YYYY-MM-DD" / day-of-month and "HH:MM" strings.
  function pickerValue(kind: 'date' | 'time') {
    const value = new Date();
    const time = scheduledTime.match(/^(\d{1,2}):(\d{2})$/);
    if (time) value.setHours(Number(time[1]), Number(time[2]), 0, 0);
    if (kind === 'date') {
      const date = scheduledDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (frequency === 'Once' && date) value.setFullYear(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
      if (frequency === 'Monthly' && /^\d{1,2}$/.test(scheduledDate)) value.setDate(Number(scheduledDate));
    }
    return value;
  }

  function applyPicked(kind: 'date' | 'time', picked: Date) {
    if (kind === 'time') setScheduledTime(`${pad(picked.getHours())}:${pad(picked.getMinutes())}`);
    else if (frequency === 'Monthly') setScheduledDate(String(picked.getDate()));
    else setScheduledDate(`${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}`);
  }

  function openPicker(kind: 'date' | 'time') {
    if (!DateTimePicker) return;
    if (Platform.OS !== 'android') {
      setIosPicker((current) => current === kind ? null : kind);
      return;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    try {
      DateTimePicker.DateTimePickerAndroid.open({
        value: pickerValue(kind),
        mode: kind,
        is24Hour: true,
        minimumDate: kind === 'date' && frequency === 'Once' ? today : undefined,
        // Called only when a value is picked; cancelling just closes the dialog.
        onValueChange: (_event, picked) => applyPicked(kind, picked),
      });
    } catch {
      Alert.alert('Update needed', 'The date picker needs the latest version of the app. Please install the new build.');
    }
  }

  function formatScheduledDate() {
    if (!scheduledDate) return frequency === 'Monthly' ? 'Pick a day' : 'Pick a date';
    if (frequency === 'Monthly') return `Day ${scheduledDate}`;
    const match = scheduledDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return scheduledDate;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const profileTasks = useMemo(() => {
    const uniqueTasks = Array.from(new Map(tasks.map((task) => [`${task.project}|${task.title.trim().toLowerCase()}|${task.frequency}|${task.scheduledDate ?? ''}|${task.scheduledTime ?? ''}`, task])).values());
    if (profileFilter === 'Completed') return uniqueTasks.filter((task) => task.done);
    if (profileFilter === 'Failed') return uniqueTasks.filter((task) => isTaskFailed(task, now));
    if (profileFilter === 'Pending') return uniqueTasks.filter((task) => !task.done && !isTaskFailed(task, now));
    return uniqueTasks;
  }, [now, profileFilter, tasks]);

  const avatarLabel = username?.match(/[a-z0-9]/i)?.[0].toUpperCase() ?? '?';
  const validProfileDetails = validUsernamePattern.test(usernameDraft.trim()) && validPhonePattern.test(phoneDraft.trim());

  function applyUser(user: UserRecord) {
    setUserId(user.id);
    setTasks(user.tasks ?? []);
    setTasksSynced(true);
    setUsername(user.username ?? '');
    setPhoneNumber(user.phone ?? '');
  }

  async function startSession(id: string, mode: SessionMode, profile: { username: string; phone: string; email?: string }) {
    setAuthBusy(true);
    try {
      const user = await openSession(id, mode, profile);
      await AsyncStorage.multiSet([['taskflow.username', user.username ?? profile.username], ['taskflow.phone', user.phone ?? profile.phone], ['taskflow.userId', user.id]]);
      applyUser(user);
    } finally {
      setAuthBusy(false);
    }
  }

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
    try {
      await startSession(localUserId(name, phone), authMode, { username: name, phone });
    } catch (error) {
      Alert.alert(authMode === 'signin' ? 'Sign in failed' : 'Could not create account', error instanceof Error ? error.message : 'Please try again.');
    }
  }

  async function signInWithGoogle() {
    if (!GoogleAuth) {
      Alert.alert('Google sign-in unavailable', Platform.OS === 'web'
        ? 'Google sign-in is only available in the Todo Android app.'
        : 'Google sign-in does not work in Expo Go. Open the Todo development build instead.');
      return;
    }
    const { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } = GoogleAuth;
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) return;
      const { user } = response.data;
      const name = user.givenName || user.name || user.email;
      await startSession(googleUserId(user.id), 'upsert', { username: name, phone: '', email: user.email });
    } catch (error) {
      if (isErrorWithCode(error) && error.code === statusCodes.IN_PROGRESS) return;
      Alert.alert('Google sign-in failed', error instanceof Error ? error.message : 'Please try again.');
    }
  }

  async function logout() {
    await Notifications?.cancelAllScheduledNotificationsAsync().catch(() => undefined);
    await GoogleAuth?.GoogleSignin.signOut().catch(() => undefined);
    await AsyncStorage.multiRemove(['taskflow.username', 'taskflow.phone', 'taskflow.userId']);
    setTasksSynced(false);
    setUserId(null);
    setTasks([]);
    setUsername(null);
    setPhoneNumber(null);
    setUsernameDraft('');
    setPhoneDraft('');
    setAuthMode('signin');
    setIsProfileOpen(false);
  }

  async function openNotificationSoundSettings() {
    const packageName = Constants.expoConfig?.android?.package ?? 'com.lumero4.taskflow';
    try {
      await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
        { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
        { key: 'android.provider.extra.CHANNEL_ID', value: channelId ?? DEVICE_CHANNEL_ID },
      ]);
    } catch {
      // Older or customised Android versions: fall back to the app's settings page.
      Linking.openSettings().catch(() => Alert.alert('Could not open settings', 'Open Settings > Apps > Todo > Notifications to change the sound.'));
    }
  }

  function confirmLogout() {
    Alert.alert('Log out?', 'Are you sure you want to log out of your current account?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: logout },
    ]);
  }

  async function ensureNotificationPermission() {
    if (Platform.OS === 'web' || !Notifications) return false;
    const permissions = await Notifications.getPermissionsAsync();
    return permissions.granted || (await Notifications.requestPermissionsAsync()).granted;
  }

  async function scheduleNotificationAt(at: number, title: string, body: string, taskId: string) {
    if (!Notifications) return undefined;
    return Notifications.scheduleNotificationAsync({
      content: { title, body, data: { taskId }, sound: true, priority: Notifications.AndroidNotificationPriority.MAX, vibrate: [0, 800, 400, 800, 400, 800, 400, 800, 400, 800] },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), channelId: channelId ?? DEVICE_CHANNEL_ID },
    });
  }

  // Schedules every reminder plus the "Deadline reached" alert for the task's next deadline.
  async function scheduleTaskAlerts(task: Task) {
    cancelTaskAlerts(task, false).catch(() => undefined);
    const { deadline, notifications } = planTaskNotifications(task, Date.now(), defaultReminderPercent);
    if (notifications.length === 0 || !(await ensureNotificationPermission())) return { scheduledFor: deadline, alertIds: [], alertsVersion: ALERTS_VERSION, alertsChannel: channelId ?? undefined };
    const alertIds: string[] = [];
    for (const item of notifications) {
      const id = await scheduleNotificationAt(item.at, item.title, item.body, task.id);
      if (id) alertIds.push(id);
    }
    return { scheduledFor: deadline, alertIds, alertsVersion: ALERTS_VERSION, alertsChannel: channelId ?? undefined };
  }

  async function cancelTaskAlerts(task: Task, includeTimer = true) {
    if (!Notifications) return;
    // deadlineNotificationId: left over from the previous version of deadline alerts.
    const legacyDeadlineId = (task as Task & { deadlineNotificationId?: string }).deadlineNotificationId;
    const ids = [...(task.alertIds ?? []), task.notificationId, legacyDeadlineId, includeTimer ? task.timerNotificationId : undefined];
    await Promise.all(ids.filter((id): id is string => !!id).map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined)));
  }

  // Clearing these makes the scheduler below plan the task's notifications again.
  const clearedAlerts = { scheduledFor: undefined, alertIds: undefined, notificationId: undefined };


  function resetTaskForm() {
    setDraft('');
    setDescriptionDraft('');
    setDurationDraft('30');
    setTimerEnabled(false);
    setFrequency('Once');
    setSelectedWeekdays([]);
    setScheduledDate('');
    setScheduledTime('');
    setReminderChoice('auto');
    setCustomReminderDraft('');
    setTaskProject(defaultTaskProject);
  }

  function openTaskEditor(task: Task) {
    const minutes = task.customReminderMinutes;
    setDraft(task.title);
    setDescriptionDraft(task.description);
    setTaskProject(task.project === 'Work' ? 'Work' : 'Personal');
    setTimerEnabled(task.allottedMinutes !== undefined);
    setDurationDraft(String(task.allottedMinutes ?? 30));
    setFrequency(task.frequency);
    setSelectedWeekdays(task.weekdays ?? []);
    setScheduledDate(task.scheduledDate ?? '');
    setScheduledTime(task.scheduledTime ?? '');
    setReminderChoice(task.frequentReminders ? 'every20' : minutes ? ([15, 60, 1440].includes(minutes) ? minutes : 'custom') : 'auto');
    setCustomReminderDraft(minutes && ![15, 60, 1440].includes(minutes) ? String(minutes) : '');
    setEditingTaskId(task.id);
    setIsCreating(true);
  }

  function closeTaskEditor() {
    setIsCreating(false);
    if (editingTaskId) {
      setEditingTaskId(null);
      resetTaskForm();
    }
    if (isReschedulingFailed) {
      setIsReschedulingFailed(false);
      setIsProfileOpen(true);
    }
  }

  // A failed task's deadline has passed, so refreshing it means picking a new one.
  function rescheduleFailedTask(task: Task) {
    setIsReschedulingFailed(true);
    setIsProfileOpen(false);
    openTaskEditor(task);
  }

  function confirmRemoveTask(task: Task) {
    Alert.alert('Delete task?', `"${task.title}" will be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => removeTask(task.id) },
    ]);
  }

  async function saveTask() {
    const title = draft.trim();
    if (!title) return;
    if (frequency === 'Once' && getNextScheduledDeadline({ frequency, scheduledDate: scheduledDate.trim(), scheduledTime: scheduledTime.trim() } as Task, Date.now()) <= Date.now()) {
      Alert.alert('Pick a future time', 'The deadline has already passed. Choose a date and time that is still to come.');
      return;
    }
    const allottedMinutes = Math.max(1, Number.parseInt(durationDraft, 10) || 30);
    const timerData = timerEnabled ? { allottedMinutes } : {};
    const customMinutes = reminderChoice === 'custom' ? Number.parseInt(customReminderDraft, 10) : reminderChoice;
    const reminderData = reminderChoice === 'every20'
      ? { frequentReminders: true }
      : typeof customMinutes === 'number' && customMinutes > 0 ? { customReminderMinutes: customMinutes } : {};
    const editedTask = editingTaskId ? tasks.find((task) => task.id === editingTaskId) : undefined;
    if (editedTask) {
      // Old reminders no longer match; cancel them in the background (never block saving on the
      // notification system) and let the scheduler plan new ones from the updated details.
      cancelTaskAlerts(editedTask, false).catch((error) => console.warn('Could not cancel old reminders', error));
      setTasks((current) => current.map((task) => task.id === editedTask.id ? {
        ...task,
        ...clearedAlerts,
        title,
        description: descriptionDraft.trim(),
        project: taskProject,
        frequency,
        weekdays: frequency === 'Several times weekly' || frequency === 'Weekly' ? selectedWeekdays : undefined,
        scheduledDate: frequency === 'Once' || frequency === 'Monthly' ? scheduledDate.trim() : undefined,
        scheduledTime: scheduledTime.trim(),
        deadline: undefined,
        allottedMinutes: timerEnabled ? allottedMinutes : undefined,
        frequentReminders: undefined,
        customReminderMinutes: undefined,
        ...reminderData,
      } : task));
      closeTaskEditor();
      showToast(`Changes saved to "${title}"`);
      return;
    }

    const createdAt = Date.now();
    setTasks((current) => [
      {
        id: createdAt.toString(),
        createdAt,
        title,
        description: descriptionDraft.trim(),
        project: taskProject,
        due: 'Today',
        frequency,
        weekdays: frequency === 'Several times weekly' || frequency === 'Weekly' ? selectedWeekdays : undefined,
        scheduledDate: frequency === 'Once' || frequency === 'Monthly' ? scheduledDate.trim() : undefined,
        scheduledTime: scheduledTime.trim(),
        done: false,
        accent: '#000000',
        ...timerData,
        ...reminderData,
      },
      ...current,
    ]);
    resetTaskForm();
    setIsCreating(false);
    showToast(`Task "${title}" created`);
    setIsProfileOpen(false);
  }

  async function startTaskTimer(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (!task?.allottedMinutes || task.startedAt) return;
    const startedAt = Date.now();
    const timerEndsAt = startedAt + task.allottedMinutes * 60000;
    const timerNotificationId = await ensureNotificationPermission()
      ? await scheduleNotificationAt(timerEndsAt, "Time's up", `Your ${formatMinutes(task.allottedMinutes)} for "${task.title}" are up.`, task.id)
      : undefined;
    setTasks((current) => current.map((item) => item.id === id
      ? { ...item, startedAt, timerEndsAt, timerNotificationId, deadline: getNextScheduledDeadline(task, startedAt) }
      : item));
    showToast(`Timer started: ${formatMinutes(task.allottedMinutes)}`, 'timer-outline');
  }

  async function toggleTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    cancelTaskAlerts(task).catch(() => undefined);
    const cleared = { ...clearedAlerts, deadline: undefined, timerEndsAt: undefined, timerNotificationId: undefined };
    if (task.done) {
      setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...cleared, done: false, startedAt: undefined } : item)));
      showToast(`"${task.title}" moved back to ongoing`, 'arrow-undo-outline');
      return;
    }
    setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...cleared, done: true } : item)));
    showToast(`"${task.title}" completed`);
  }

  async function removeTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (task) cancelTaskAlerts(task).catch(() => undefined);
    setTasks((current) => current.filter((task) => task.id !== id));
    setExpandedTaskId(null);
    if (task) showToast(`"${task.title}" deleted`, 'trash-outline');
  }

  function refreshTask(id: string) {
    const task = tasks.find((item) => item.id === id);
    if (task) cancelTaskAlerts(task).catch(() => undefined);
    setTasks((current) => current.map((item) => item.id === id
      ? { ...item, ...clearedAlerts, done: false, deadline: undefined, startedAt: undefined, timerEndsAt: undefined, timerNotificationId: undefined }
      : item));
    if (task) showToast(`"${task.title}" is active again`, 'refresh-outline');
  }

  // Keep reminders + a "Deadline reached" alert scheduled for every unfinished task; repeating tasks get the next set after each deadline.
  const schedulingDeadlineIds = React.useRef(new Set<string>());
  const minuteTick = Math.floor(now / 60000);
  useEffect(() => {
    if (!tasksSynced || !Notifications || !channelId) return;
    const currentTime = Date.now();
    const due = tasks.filter((task) => !task.done
      && !schedulingDeadlineIds.current.has(task.id)
      && (task.scheduledFor === undefined
        || task.alertsVersion !== ALERTS_VERSION
        || task.alertsChannel !== channelId
        || (task.scheduledFor + FAIL_GRACE_MS <= currentTime && task.frequency !== 'Once')));
    due.forEach(async (task) => {
      schedulingDeadlineIds.current.add(task.id);
      try {
        const alert = await scheduleTaskAlerts(task);
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, ...alert } : item));
      } catch (error) {
        console.warn('Could not schedule task notifications', error);
      } finally {
        schedulingDeadlineIds.current.delete(task.id);
      }
    });
  }, [channelId, minuteTick, tasks, tasksSynced]);

  // Android back button/gesture: step back one screen instead of closing the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isFilterOpen) setIsFilterOpen(false);
      else if (username === null || phoneNumber === null) {
        if (!onBack) return false;
        onBack();
      }
      else if (isCreating) closeTaskEditor();
      else if (isReminderOpen) setIsReminderOpen(false);
      else if (isProfileOpen) setIsProfileOpen(false);
      else if (expandedTaskId) setExpandedTaskId(null);
      else return false; // On the main task list, let Android close the app as usual.
      return true;
    });
    return () => subscription.remove();
  }, [editingTaskId, expandedTaskId, isCreating, isReschedulingFailed, isFilterOpen, isProfileOpen, isReminderOpen, onBack, phoneNumber, username]);

  // Shown briefly while the saved account and its tasks load.
  if (!profileLoaded) {
    return (
      <SafeAreaView style={[styles.safeArea, styles.loadingScreen]}>
        <StatusBar style={colors.statusBar} />
        <ActivityIndicator size="large" color={colors.text} />
      </SafeAreaView>
    );
  }

  if (username === null || phoneNumber === null) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style={colors.statusBar} />
        {/* padding (not height) so the keyboard only adds space at the bottom and never pushes the form under the status bar */}
        <KeyboardAvoidingView style={styles.container} behavior="padding">
          <ScrollView
            contentContainerStyle={styles.profilePage}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {onBack && (
              <TouchableOpacity onPress={onBack} accessibilityLabel="Go back" style={[styles.backButton, { marginBottom: 18 }]}>
                <Ionicons name="arrow-back" size={18} color={colors.text} />
              </TouchableOpacity>
            )}
            <Text style={[styles.profileEyebrow, { color: colors.text }]}>WELCOME TO TODO</Text>
            <Text style={styles.profileTitle}>{authMode === 'signin' ? 'Welcome back.' : 'Create your account.'}</Text>
            <Text style={styles.profileSubtitle}>{authMode === 'signin' ? 'Sign in to continue managing your tasks.' : 'Create an account to start organizing your tasks.'}</Text>
            <View style={styles.authOptions}>
              <TouchableOpacity onPress={() => setAuthMode('signin')} style={[styles.authOption, authMode === 'signin' && styles.authOptionActive]}>
                <Text style={[styles.authOptionText, authMode === 'signin' && styles.authOptionTextActive]}>Sign in</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setAuthMode('create')} style={[styles.authOption, authMode === 'create' && styles.authOptionActive, authMode === 'create' && styles.signupAuthOptionActive]}>
                <Text style={[styles.authOptionText, authMode === 'create' && styles.authOptionTextActive]}>Create account</Text>
              </TouchableOpacity>
            </View>
            <TextInput autoFocus value={usernameDraft} onChangeText={setUsernameDraft} placeholder="USER NAME" accessibilityLabel="User name, 4 letters or numbers" placeholderTextColor="#9BA09A" maxLength={4} autoCapitalize="none" style={[styles.taskInput, { color: colors.text, marginBottom: 14 }]} />
            <TextInput value={phoneDraft} onChangeText={setPhoneDraft} placeholder="PHONE NUMBER" accessibilityLabel="Phone number, 9 digits" placeholderTextColor="#9BA09A" keyboardType="number-pad" maxLength={9} style={[styles.taskInput, { color: colors.text }]} onSubmitEditing={saveProfile} />
            <TouchableOpacity onPress={saveProfile} disabled={!validProfileDetails || authBusy} style={[styles.saveButton, authMode === 'create' && styles.signupSaveButton, (!validProfileDetails || authBusy) && styles.saveButtonDisabled]}>
              <Text style={styles.saveButtonText}>{authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.authDivider}>
              <View style={styles.authDividerLine} />
              <Text style={styles.authDividerText}>or</Text>
              <View style={styles.authDividerLine} />
            </View>
            <TouchableOpacity onPress={signInWithGoogle} style={styles.googleButton}>
              <Ionicons name="logo-google" size={16} color={colors.text} />
              <Text style={styles.googleButtonText}>{authMode === 'create' ? 'Sign up with Google' : 'Continue with Google'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (isProfileOpen) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style={colors.statusBar} />
        <View style={styles.container}>
          <View style={styles.profileHeader}>
            <TouchableOpacity onPress={() => setIsProfileOpen(false)} accessibilityLabel="Go back to dashboard" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.profileAvatar}><Text style={styles.profileAvatarText}>{avatarLabel}</Text></View>
            <View style={styles.profileHeaderCopy}><Text style={styles.profileName}>{username}</Text><Text style={styles.profileTaskCount}>{phoneNumber ? `${phoneNumber}  •  ` : ''}{tasks.length} tasks</Text></View>
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
            ListEmptyComponent={<View style={styles.empty}><Ionicons name="checkmark-circle-outline" size={30} color={colors.text} /><Text style={styles.emptyTitle}>No {profileFilter.toLowerCase()} tasks</Text></View>}
            renderItem={({ item }) => (
              <View style={[styles.profileTaskRow, item.done && styles.completedCard]}>
                <View style={styles.profileTaskBody}><Text style={[styles.taskTitle, item.done && styles.completedText]}>{item.title}</Text><Text style={styles.profileTaskMeta}>{item.project}  •  {getScheduleLabel(item)}</Text>{isTaskFailed(item, now) && <View style={styles.failedBadge}><Ionicons name="alert-circle" size={13} color="#D85C43" /><Text style={styles.failedBadgeText}>Failed</Text></View>}</View>
                {isTaskFailed(item, now) ? (
                  <TouchableOpacity onPress={() => rescheduleFailedTask(item)} accessibilityLabel={`Refresh ${item.title} with a new deadline`} style={styles.taskActionButton}>
                    <Ionicons name="refresh-outline" size={15} color={colors.text} />
                    <Text style={styles.taskActionText}>Refresh</Text>
                  </TouchableOpacity>
                ) : (
                  <Ionicons name={item.done ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={item.done ? '#8B9A6B' : '#B7BDB6'} />
                )}
              </View>
            )}
          />
          <View style={[styles.timerSetting, styles.themeSetting, Platform.OS === 'android' && styles.settingStacked]}>
            <View style={styles.timerCopy}>
              <Ionicons name={mode === 'dark' ? 'moon' : 'moon-outline'} size={19} color={colors.text} />
              <Text style={styles.timerTitle}>Dark mode</Text>
            </View>
            <TouchableOpacity
              onPress={toggleTheme}
              accessibilityRole="switch"
              accessibilityLabel="Dark mode"
              accessibilityState={{ checked: mode === 'dark' }}
              style={[styles.toggle, mode === 'dark' && styles.toggleActive]}
            >
              <View style={[styles.toggleKnob, mode === 'dark' && styles.toggleKnobActive]} />
            </TouchableOpacity>
          </View>
          {Platform.OS === 'android' && (
            <TouchableOpacity onPress={openNotificationSoundSettings} accessibilityRole="button" accessibilityLabel="Alarm sound settings" style={[styles.timerSetting, styles.soundSetting]}>
              <View style={styles.timerCopy}>
                <Ionicons name="musical-notes-outline" size={19} color={colors.text} />
                <View>
                  <Text style={styles.timerTitle}>Alarm sound</Text>
                  <Text style={styles.timerSubtitle}>Change the sound, or let alarms ring in Do Not Disturb</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.text} />
            </TouchableOpacity>
          )}
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
        <StatusBar style={colors.statusBar} />
        <View style={styles.container}>
          <View style={styles.createHeader}>
            <TouchableOpacity onPress={() => setIsReminderOpen(false)} accessibilityLabel="Go back to dashboard" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.createHeaderTitle}>Reminders</Text>
            <View style={styles.headerSpacer} />
          </View>
          <FlatList
            data={pendingTasks}
            keyExtractor={(item) => `reminder-${item.id}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={(
              <View>
                <Text style={styles.createTitle}>Reminders</Text>
                <Text style={styles.createSubtitle}>Every reminder arrives as a notification and an alert. Choose a task's reminder under REMIND ME when you create it.</Text>
              </View>
            )}
            ListEmptyComponent={<View style={styles.empty}><Ionicons name="notifications-off-outline" size={30} color={colors.text} /><Text style={styles.emptyTitle}>No pending tasks</Text><Text style={styles.emptyText}>Completed and overdue tasks cannot receive reminders.</Text></View>}
            renderItem={({ item }) => {
              const reminderLabel = item.frequentReminders ? 'Every 20%' : item.customReminderMinutes ? `${formatMinutes(item.customReminderMinutes)} before` : `Auto (${defaultReminderPercent}% left)`;
              return (
                <View style={styles.reminderTaskRow}>
                  <View style={styles.reminderTaskCopy}><Text style={styles.taskTitle}>{item.title}</Text><Text style={styles.profileTaskMeta}>{getScheduleLabel(item)}</Text></View>
                  <View style={styles.reminderBadge}>
                    <Ionicons name="notifications-outline" size={13} color={colors.text} />
                    <Text style={styles.reminderBadgeText}>{reminderLabel}</Text>
                  </View>
                </View>
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
        <StatusBar style={colors.statusBar} />
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.createHeader}>
            <TouchableOpacity onPress={closeTaskEditor} accessibilityLabel="Go back" style={styles.backButton}>
              <Ionicons name="arrow-back" size={18} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.createHeaderTitle}>{editingTaskId ? 'Edit task' : 'New task'}</Text>
            <View style={styles.headerSpacer} />
          </View>

          <ScrollView
            style={styles.createScroll}
            contentContainerStyle={styles.createContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.createEyebrow}>{isReschedulingFailed ? 'REFRESH FAILED TASK' : editingTaskId ? 'EDIT TASK' : 'ADD TO YOUR LIST'}</Text>
            <Text style={styles.createTitle}>{isReschedulingFailed ? 'Pick a new deadline' : editingTaskId ? 'Update this task' : 'Make it happen'}</Text>
            <Text style={styles.createSubtitle}>Keep it simple. You can set a duration when this task needs one.</Text>

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
              autoFocus={!editingTaskId}
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
                <Ionicons name="timer-outline" size={19} color={colors.text} />
                <View>
                  <Text style={styles.timerTitle}>Duration of task</Text>
                  <Text style={styles.timerSubtitle}>Set how long this task should take</Text>
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

            {(frequency === 'Once' || frequency === 'Monthly' || frequency === 'Daily' || frequency === 'Weekly' || frequency === 'Several times weekly') && (
              <View style={styles.oneTimeFields}>
                <Text style={styles.fieldLabel}>{frequency === 'Once' ? 'WHEN SHOULD IT HAPPEN?' : frequency === 'Monthly' ? 'WHEN EACH MONTH?' : 'TIME OF DAY'}</Text>
                {DateTimePicker ? (
                  <View style={styles.dateTimeRow}>
                    {(frequency === 'Once' || frequency === 'Monthly') && (
                      <TouchableOpacity onPress={() => openPicker('date')} accessibilityLabel={frequency === 'Monthly' ? 'Pick day of month' : 'Pick date'} style={[styles.dateTimeInput, styles.pickerField]}>
                        <Ionicons name="calendar-outline" size={17} color={colors.text} />
                        <Text style={[styles.pickerText, !scheduledDate && styles.pickerPlaceholder]} numberOfLines={1}>{formatScheduledDate()}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={() => openPicker('time')} accessibilityLabel="Pick time" style={[styles.timeInput, styles.pickerField, frequency !== 'Once' && frequency !== 'Monthly' && styles.timeInputFull]}>
                      <Ionicons name="time-outline" size={17} color={colors.text} />
                      <Text style={[styles.pickerText, !scheduledTime && styles.pickerPlaceholder]}>{scheduledTime || 'Time'}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.dateTimeRow}>
                    {(frequency === 'Once' || frequency === 'Monthly') && <TextInput value={scheduledDate} onChangeText={setScheduledDate} placeholder={frequency === 'Monthly' ? 'Day 1-31' : 'YYYY-MM-DD'} placeholderTextColor="#9BA09A" style={styles.dateTimeInput} />}
                    <TextInput value={scheduledTime} onChangeText={setScheduledTime} placeholder="HH:MM" placeholderTextColor="#9BA09A" keyboardType="numbers-and-punctuation" style={[styles.timeInput, frequency !== 'Once' && frequency !== 'Monthly' && styles.timeInputFull]} />
                  </View>
                )}
                {DateTimePicker && iosPicker && (
                  <DateTimePicker.default
                    value={pickerValue(iosPicker)}
                    mode={iosPicker}
                    display="spinner"
                    themeVariant={mode}
                    minimumDate={iosPicker === 'date' && frequency === 'Once' ? new Date(new Date().setHours(0, 0, 0, 0)) : undefined}
                    onValueChange={(_event, picked) => applyPicked(iosPicker, picked)}
                  />
                )}
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

            <Text style={[styles.fieldLabel, styles.reminderSectionLabel]}>REMIND ME</Text>
            <View style={styles.frequencyOptions}>
              {([['auto', `Auto (${defaultReminderPercent}% left)`], ['every20', 'Every 20%'], [15, '15 min before'], [60, '1 hour before'], [1440, '1 day before'], ['custom', 'Custom']] as const).map(([value, label]) => (
                <TouchableOpacity key={String(value)} onPress={() => setReminderChoice(value)} style={[styles.frequencyOption, reminderChoice === value && styles.frequencyOptionActive]}>
                  <Text style={[styles.frequencyOptionText, reminderChoice === value && styles.frequencyOptionTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {reminderChoice === 'custom' && (
              <View style={[styles.durationRow, styles.customReminderRow]}>
                <TextInput value={customReminderDraft} onChangeText={(text) => setCustomReminderDraft(text.replace(/[^0-9]/g, ''))} placeholder="30" placeholderTextColor="#9BA09A" keyboardType="number-pad" maxLength={5} accessibilityLabel="Minutes before the deadline" style={styles.durationLargeInput} />
                <Text style={styles.durationUnit}>minutes before the deadline</Text>
              </View>
            )}

            <TouchableOpacity onPress={() => saveTask().catch((error) => Alert.alert('Could not save task', error instanceof Error ? error.message : 'Please try again.'))} disabled={!draft.trim() || !scheduledTime.trim() || ((frequency === 'Weekly' || frequency === 'Several times weekly') && selectedWeekdays.length === 0) || ((frequency === 'Once' || frequency === 'Monthly') && !scheduledDate.trim())} style={[styles.saveButton, (!draft.trim() || !scheduledTime.trim() || ((frequency === 'Weekly' || frequency === 'Several times weekly') && selectedWeekdays.length === 0) || ((frequency === 'Once' || frequency === 'Monthly') && !scheduledDate.trim())) && styles.saveButtonDisabled]}>
              <Text style={styles.saveButtonText}>{editingTaskId ? 'Save changes' : 'Create task'}</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.text} />
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={colors.statusBar} />
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
              <Ionicons name="notifications-outline" size={15} color={colors.text} />
            </TouchableOpacity>
            <Animated.View
              {...addButtonPanResponder.panHandlers}
              style={[styles.addFloatingButton, { transform: addButtonPosition.getTranslateTransform() }]}
            >
              <TouchableOpacity onPress={() => { setTaskProject(defaultTaskProject); setIsCreating(true); }} accessibilityLabel="Create new task" style={styles.addFloatingButtonTouchTarget}>
                <Ionicons name="add" size={20} color={colors.text} />
              </TouchableOpacity>
            </Animated.View>
          </View>
          <TouchableOpacity onPress={() => setIsProfileOpen(true)} accessibilityLabel="Open profile" style={styles.dashboardAvatar}>
            <Text style={styles.dashboardAvatarText}>{avatarLabel}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.projectTabs}>
          {([['ongoing', 'Ongoing', 'list-outline'], ['completed', 'Completed', 'checkmark-circle-outline']] as const).map(([value, label, icon]) => (
            <TouchableOpacity key={value} onPress={() => setStatusTab(value)} accessibilityRole="tab" accessibilityState={{ selected: statusTab === value }} style={[styles.projectTab, statusTab === value && styles.projectTabActive]}>
              <Ionicons name={icon} size={14} color={colors.text} />
              <Text style={[styles.projectTabText, statusTab === value && styles.projectTabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionTitle}>{statusTab === 'completed' ? 'Completed tasks' : 'Ongoing tasks'}</Text>
            <Text style={styles.taskCount}>{visibleTasks.length} total</Text>
          </View>
          <TouchableOpacity onPress={() => setIsFilterOpen((open) => !open)} accessibilityLabel={`Filter tasks, showing ${projectFilter}`} style={styles.filterButton}>
            <Ionicons name="funnel-outline" size={13} color={colors.text} />
            <Text style={styles.filterButtonText}>{projectFilter}</Text>
            <Ionicons name={isFilterOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.text} />
          </TouchableOpacity>
        </View>
        {isFilterOpen && (
          <View style={styles.filterMenu}>
            {(['All', 'Personal', 'Work'] as const).map((option) => (
              <TouchableOpacity key={option} onPress={() => { setProjectFilter(option); setIsFilterOpen(false); }} style={styles.filterOption}>
                <Ionicons name={option === 'All' ? 'apps-outline' : option === 'Personal' ? 'person-outline' : 'briefcase-outline'} size={15} color={colors.text} />
                <Text style={[styles.filterOptionText, projectFilter === option && styles.filterOptionTextActive]}>{option}</Text>
                {projectFilter === option && <Ionicons name="checkmark" size={15} color={colors.text} />}
              </TouchableOpacity>
            ))}
          </View>
        )}
        {visibleTasks.length === 0 ? (
          <View style={styles.empty}><Ionicons name={statusTab === 'completed' ? 'checkmark-circle-outline' : 'list-outline'} size={30} color={colors.text} /><Text style={styles.emptyTitle}>Nothing here yet</Text><Text style={styles.emptyText}>{statusTab === 'completed' ? 'Tasks you complete will appear here.' : 'Add a task and keep the momentum going.'}</Text></View>
        ) : visibleTasks.map((item) => (
            <View key={item.id} style={styles.taskItem}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => setExpandedTaskId((current) => current === item.id ? null : item.id)} style={[styles.taskCard, item.done && styles.completedCard]}>
                <TouchableOpacity onPress={() => toggleTask(item.id)} style={[styles.checkbox, item.done && styles.checked]}>
                  {item.done && <Ionicons name="checkmark" size={13} color="#FFFFFF" />}
                </TouchableOpacity>
                <View style={styles.taskBody}>
                  <Text style={[styles.taskTitle, styles.taskCardTitle, item.done && styles.completedText]}>{item.title}</Text>
                  <View style={styles.metaRow}><Text style={[styles.meta, styles.taskCardMeta]}>{item.project}</Text><Text style={[styles.metaDivider, styles.taskCardMeta]}>•</Text><Text style={[styles.meta, styles.taskCardMeta]}>{getScheduleLabel(item)}</Text>{item.allottedMinutes !== undefined && <><Text style={[styles.metaDivider, styles.taskCardMeta]}>•</Text><Text style={[styles.meta, styles.taskCardMeta]}>{`${item.allottedMinutes} min`}</Text></>}</View>
                  {getOverdueGraceLeft(item, now) !== undefined && (
                    <Text style={[styles.meta, styles.overdueMeta, styles.statusMeta]}>Overdue</Text>
                  )}
                  {expandedTaskId === item.id && <View style={styles.taskDetails}>
                    <Text style={styles.descriptionText}>{item.description || 'No description added.'}</Text>
                    {item.allottedMinutes !== undefined && !item.done && <TouchableOpacity onPress={() => startTaskTimer(item.id)} disabled={item.startedAt !== undefined} style={[styles.startButton, item.startedAt !== undefined && styles.startButtonDisabled]}>
                      <Ionicons name={item.startedAt !== undefined ? 'time-outline' : 'play'} size={14} color={colors.text} />
                      <Text style={styles.startButtonText}>{item.startedAt === undefined ? 'Start task' : now >= (item.timerEndsAt ?? item.deadline ?? now) ? "Time's up" : `${Math.ceil(((item.timerEndsAt ?? item.deadline ?? now) - now) / 60000)} min left`}</Text>
                    </TouchableOpacity>}
                    <View style={styles.taskActions}>
                      <TouchableOpacity onPress={() => openTaskEditor(item)} accessibilityLabel={`Edit ${item.title}`} style={styles.taskActionButton}>
                        <Ionicons name="create-outline" size={15} color={colors.text} />
                        <Text style={styles.taskActionText}>Edit</Text>
                      </TouchableOpacity>
                      {item.done && (
                        <TouchableOpacity onPress={() => refreshTask(item.id)} accessibilityLabel={`Refresh ${item.title}`} style={styles.taskActionButton}>
                          <Ionicons name="refresh-outline" size={15} color={colors.text} />
                          <Text style={styles.taskActionText}>Refresh</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => confirmRemoveTask(item)} accessibilityLabel={`Delete ${item.title}`} style={[styles.taskActionButton, styles.taskDeleteButton]}>
                        <Ionicons name="trash-outline" size={15} color="#E14F3D" />
                        <Text style={styles.deleteMenuText}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>}
                </View>
                <View style={styles.moreButton}>
                  <Ionicons name={expandedTaskId === item.id ? 'chevron-up' : 'chevron-down'} size={17} color="#9BA09A" />
                </View>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AppContent() {
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);

  if (authMode) return <TaskflowApp initialAuthMode={authMode} onBack={() => setAuthMode(null)} />;
  return <LandingPage onGetStarted={() => setAuthMode('create')} onSignIn={() => setAuthMode('signin')} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ToastProvider>
          <CrashBoundary>
            <AppContent />
          </CrashBoundary>
        </ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>
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

const crashStyles = StyleSheet.create({
  crashScreen: { flex: 1, backgroundColor: '#1A0E0C', padding: 24 },
  crashTitle: { color: '#FF9A8A', fontSize: 28, fontWeight: '800', marginBottom: 12 },
  crashMessage: { color: '#FFFFFF', fontSize: 17, marginBottom: 24 },
  crashLog: { color: '#FFC9BE', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
});

function createStyles(c: Palette) {
  return StyleSheet.create({
  loadingScreen: { justifyContent: 'center', alignItems: 'center' },
  safeArea: { flex: 1, backgroundColor: c.bg },
  container: { flex: 1, paddingHorizontal: 22 },
  dashboardScroll: { flex: 1 },
  dashboardContent: { flexGrow: 1, justifyContent: 'flex-start', paddingBottom: 40 },
  // flexGrow keeps the form centred when it fits and lets it scroll when the keyboard is open.
  profilePage: { flexGrow: 1, justifyContent: 'center', paddingTop: 16, paddingBottom: 32 },
  profileEyebrow: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12 },
  profileTitle: { color: c.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.4 },
  profileSubtitle: { color: c.text, fontSize: 15, lineHeight: 21, marginTop: 10, marginBottom: 30 },
  authOptions: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  authOption: { flex: 1, alignItems: 'center', backgroundColor: c.bg, borderRadius: 12, paddingVertical: 11 },
  authOptionActive: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text },
  signupAuthOptionActive: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text },
  authOptionText: { color: c.text, fontSize: 13, fontWeight: '700' },
  authOptionTextActive: { color: c.text },
  profileHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 18, paddingBottom: 26 },
  profileAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center', marginLeft: 14, borderWidth: 1, borderColor: c.border },
  profileAvatarText: { color: c.text, fontSize: 18, fontWeight: '800' },
  profileHeaderCopy: { marginLeft: 13 },
  profileName: { color: c.text, fontSize: 22, fontWeight: '800' },
  profileTaskCount: { color: c.text, fontSize: 13, marginTop: 3 },
  profileFilters: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  profileFilter: { flex: 1, alignItems: 'center', backgroundColor: c.bg, borderRadius: 12, paddingVertical: 10 },
  profileFilterActive: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text },
  profileFilterText: { color: c.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  profileFilterTextActive: { color: c.text },
  profileTaskRow: { backgroundColor: c.bg, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: c.text },
  profileTaskBody: { flex: 1, marginHorizontal: 12 },
  profileTaskMeta: { color: c.text, fontSize: 12, marginTop: 6 },
  logoutButton: { alignSelf: 'stretch', minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.bg, borderRadius: 16, borderWidth: 1, borderColor: c.text, marginTop: 12, marginBottom: 12 },
  logoutText: { color: COLORS.danger, fontSize: 16, fontWeight: '800' },
  reminderTaskRow: { backgroundColor: c.bg, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: c.text },
  reminderTaskCopy: { flex: 1 },
  reminderCheck: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: '#3B4150', justifyContent: 'center', alignItems: 'center' },
  reminderCheckActive: { backgroundColor: c.bg, borderColor: c.text },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', width: '100%', paddingTop: 24, paddingBottom: 26 },
  headerIconActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 10 },
  headerCopy: { paddingRight: 12, marginTop: 16 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  createButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, justifyContent: 'center', alignItems: 'center' },
  eyebrow: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 10 },
  title: { color: c.text, fontSize: 29, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: c.text, fontSize: 14, marginTop: 8 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: c.text, fontSize: 15, fontWeight: '800' },
  dashboardAvatar: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  dashboardAvatarText: { color: c.text, fontSize: 16, fontWeight: '800' },
  summary: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, borderRadius: 20, padding: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  summaryLabel: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  summaryNumber: { color: c.text, fontSize: 34, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  summaryTail: { color: c.text, fontSize: 16, fontWeight: '500' },
  projectTabs: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  projectTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: c.bg, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingVertical: 11 },
  projectTabActive: { borderColor: c.text, borderWidth: 1.5 },
  projectTabText: { color: c.text, fontSize: 13, fontWeight: '600' },
  projectTabTextActive: { color: c.text, fontWeight: '700' },
  progressRing: { width: 60, height: 60, borderRadius: 30, borderWidth: 4, borderColor: c.text, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  progressText: { color: c.text, fontSize: 14, fontWeight: '800' },
  createHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 20, paddingBottom: 28 },
  backButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  createHeaderTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  headerSpacer: { width: 42 },
  createScroll: { flex: 1 },
  createContent: { paddingTop: 22, paddingBottom: 40 },
  createEyebrow: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 10 },
  createTitle: { color: c.text, fontSize: 29, fontWeight: '800', letterSpacing: -0.4 },
  createSubtitle: { color: c.text, fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 34 },
  projectOptions: { flexDirection: 'row', gap: 10, marginBottom: 26 },
  projectOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg, paddingVertical: 14 },
  projectOptionActive: { backgroundColor: c.bg, borderColor: c.text },
  projectOptionText: { color: c.text, fontSize: 14, fontWeight: '600' },
  projectOptionTextActive: { color: c.text, fontWeight: '700' },
  fieldLabel: { color: c.text, fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginBottom: 10, marginTop: 4 },
  taskInput: { backgroundColor: c.bg, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, color: c.text, fontSize: 17, paddingHorizontal: 16, paddingVertical: 16, marginBottom: 4 },
  timerSetting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.bg, borderRadius: 16, borderWidth: 1.5, borderColor: c.border, marginTop: 20, padding: 16 },
  themeSetting: { marginTop: 12, marginBottom: 20 },
  settingStacked: { marginBottom: 0 },
  soundSetting: { marginTop: 10, marginBottom: 20 },
  timerCopy: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  timerTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  timerSubtitle: { color: c.text, fontSize: 12, marginTop: 4 },
  toggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: '#2A2F3B', padding: 3, justifyContent: 'center' },
  toggleActive: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text },
  toggleKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.bg },
  toggleKnobActive: { alignSelf: 'flex-end', backgroundColor: c.text },
  durationField: { marginTop: 22 },
  durationRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bg, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, paddingHorizontal: 16 },
  durationLargeInput: { color: c.text, fontSize: 20, fontWeight: '800', paddingVertical: 15, width: 70 },
  durationUnit: { color: c.text, fontSize: 14 },
  frequencyOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  frequencyOption: { borderRadius: 18, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg, paddingHorizontal: 14, paddingVertical: 10 },
  frequencyOptionActive: { backgroundColor: c.bg, borderColor: c.text },
  frequencyOptionText: { color: c.text, fontSize: 13, fontWeight: '600' },
  frequencyOptionTextActive: { color: c.text, fontWeight: '700' },
  weekdayField: { marginTop: 24 },
  weekdayOptions: { flexDirection: 'row', justifyContent: 'space-between' },
  weekdayOption: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  weekdayOptionActive: { backgroundColor: c.bg, borderColor: c.text },
  weekdayText: { color: c.text, fontSize: 11, fontWeight: '700' },
  weekdayTextActive: { color: c.text },
  reminderBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, marginLeft: 10 },
  reminderBadgeText: { color: c.text, fontSize: 11, fontWeight: '700' },
  reminderHelp: { color: c.text, opacity: 0.65, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  reminderSectionLabel: { marginTop: 24 },
  customReminderRow: { marginTop: 10 },
  oneTimeFields: { marginTop: 24, marginBottom: 22 },
  dateTimeRow: { flexDirection: 'row', gap: 10 },
  dateTimeInput: { flex: 1, backgroundColor: c.bg, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, color: c.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 16 },
  timeInput: { width: 116, backgroundColor: c.bg, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, color: c.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 16 },
  timeInputFull: { flex: 1, width: undefined },
  pickerField: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerText: { flexShrink: 1, color: c.text, fontSize: 15 },
  pickerPlaceholder: { color: '#9BA09A' },
  descriptionInput: { backgroundColor: c.bg, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, color: c.text, fontSize: 15, minHeight: 96, paddingHorizontal: 14, paddingVertical: 14, marginBottom: 24, lineHeight: 21 },
  saveButton: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 34, minHeight: 58 },
  signupSaveButton: { backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, shadowOpacity: 0 },
  saveButtonDisabled: { opacity: 0.4, shadowOpacity: 0 },
  saveButtonText: { color: c.text, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  authDivider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 20 },
  authDividerLine: { flex: 1, height: 1, backgroundColor: c.border },
  authDividerText: { color: c.text, fontSize: 13 },
  googleButton: { backgroundColor: c.bg, borderRadius: 16, borderWidth: 1, borderColor: c.text, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14, minHeight: 58 },
  googleButtonText: { color: c.text, fontSize: 16, fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 14 },
  sectionTitle: { color: c.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  taskCount: { color: c.text, fontSize: 13 },
  list: { paddingBottom: 18 },
  filterButton: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  filterButtonText: { color: c.text, fontSize: 13, fontWeight: '700' },
  filterMenu: { borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.bg, marginBottom: 14, paddingVertical: 4, ...shadowSm },
  filterOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  filterOptionText: { flex: 1, color: c.text, fontSize: 14, fontWeight: '500' },
  filterOptionTextActive: { fontWeight: '800' },
  reminderFloatingButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  addFloatingButton: { width: 48, height: 48 },
  addFloatingButtonTouchTarget: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  taskItem: { marginBottom: 10 },
  taskCard: { backgroundColor: c.bg, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: c.border, ...shadowSm },
  taskCardTitle: { color: c.text },
  taskCardMeta: { color: c.text },
  completedCard: { backgroundColor: c.bg, shadowOpacity: 0, elevation: 0 },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: COLORS.borderStrong, justifyContent: 'center', alignItems: 'center', marginRight: 13 },
  checked: { backgroundColor: COLORS.success, borderColor: COLORS.success },
  taskBody: { flex: 1 },
  taskTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  taskDetails: { borderTopWidth: 1, borderTopColor: c.border, marginTop: 12, paddingTop: 12 },
  descriptionText: { color: c.text, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  startButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: c.bg, borderWidth: 1, borderColor: c.text, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  startButtonDisabled: { backgroundColor: COLORS.success },
  startButtonText: { color: c.text, fontSize: 12, fontWeight: '800' },
  completedText: { color: c.text, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  meta: { color: c.text, fontSize: 12 },
  statusMeta: { marginTop: 6 },
  failedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  failedBadgeText: { color: '#D85C43', fontSize: 12, fontWeight: '800' },
  overdueMeta: { color: COLORS.danger, fontWeight: '800' },
  metaDivider: { color: c.border, fontSize: 12, marginHorizontal: 7 },
  taskActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  taskActionButton: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.text, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  taskDeleteButton: { borderColor: '#E14F3D' },
  taskActionText: { color: c.text, fontSize: 13, fontWeight: '700' },
  moreButton: { paddingLeft: 10, paddingVertical: 7 },
  taskMenu: { width: '100%', backgroundColor: c.bg, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingVertical: 4, marginTop: -2, ...shadowSm },
  menuAction: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 11 },
  menuActionDisabled: { opacity: 0.6 },
  menuText: { color: c.text, fontSize: 13, fontWeight: '600' },
  menuTextDisabled: { color: c.text },
  deleteMenuText: { color: COLORS.danger, fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 56 },
  emptyTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginTop: 14 },
  emptyText: { color: c.text, fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  });
}
