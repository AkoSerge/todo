import type { Task } from './pages';

// Set in .env (EXPO_PUBLIC_API_URL).
const API_URL: string | undefined = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') || undefined;

export type SessionMode = 'create' | 'signin' | 'upsert';

export type UserRecord = {
  id: string;
  provider: 'local' | 'google';
  username?: string;
  phone?: string;
  email?: string;
  tasks: Task[];
};

// The user's login is their database id.
export const localUserId = (username: string, phone: string) => `local:${username.toLowerCase()}:${phone}`;
export const googleUserId = (googleId: string) => `google:${googleId}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_URL) throw new Error('The server address is not set. Add EXPO_PUBLIC_API_URL to the .env file.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Server responded with ${response.status}.`);
    return body as T;
  } catch (error) {
    // Timeouts (the abort above) and network failures both mean the server could not be reached.
    if (controller.signal.aborted || error instanceof TypeError) {
      throw new Error('Could not reach the server. Make sure the Todo backend is running and your phone is on the same Wi-Fi.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function openSession(id: string, mode: SessionMode, profile: { username?: string; phone?: string; email?: string }) {
  return request<UserRecord>('/api/session', { method: 'POST', body: JSON.stringify({ id, mode, profile }) });
}

export function saveTasks(id: string, tasks: Task[]) {
  return request<{ ok: true }>(`/api/users/${encodeURIComponent(id)}/tasks`, { method: 'PUT', body: JSON.stringify({ tasks }) });
}
