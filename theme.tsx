import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

export type Palette = {
  bg: string;
  text: string;
  border: string;
  statusBar: 'dark' | 'light';
};

const palettes: Record<ThemeMode, Palette> = {
  light: { bg: '#FFFFFF', text: '#000000', border: '#D9D9D9', statusBar: 'dark' },
  dark: { bg: '#000000', text: '#FFFFFF', border: '#3A3A3A', statusBar: 'light' },
};

const STORAGE_KEY = 'todo.theme';

type ThemeContextValue = { mode: ThemeMode; colors: Palette; toggleTheme: () => void };

const ThemeContext = createContext<ThemeContextValue>({ mode: 'light', colors: palettes.light, toggleTheme: () => undefined });

export function ThemeProvider({ children }: React.PropsWithChildren) {
  const [mode, setMode] = useState<ThemeMode>('light');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved === 'light' || saved === 'dark') setMode(saved);
    }).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    colors: palettes[mode],
    toggleTheme: () => setMode((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
      return next;
    }),
  }), [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

