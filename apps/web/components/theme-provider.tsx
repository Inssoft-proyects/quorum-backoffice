'use client';

/**
 * Minimal theme provider. Adds/removes the `.dark` class on <html> based on
 * a context-provided mode. Reads default from localStorage on mount.
 *
 * WU1b ships the toggle; WU7 wires it to the sidebar UI.
 */
import * as React from 'react';

type Mode = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

interface ThemeContextValue {
  mode: Mode;
  resolved: Resolved;
  setMode: (m: Mode) => void;
  toggle: () => void;
}

const STORAGE_KEY = 'qb-theme-mode';

function detectSystem(): Resolved {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredMode(): Mode {
  if (typeof window === 'undefined') return 'light';
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'light';
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<Mode>('light');
  const [systemResolved, setSystemResolved] = React.useState<Resolved>('light');

  // Hydrate from storage + system preference on mount
  React.useEffect(() => {
    const stored = readStoredMode();
    setModeState(stored);
    setSystemResolved(detectSystem());

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setSystemResolved(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved: Resolved = mode === 'system' ? systemResolved : mode;

  // Reflect into the DOM for Tailwind's .dark selector
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setMode = React.useCallback((m: Mode) => {
    setModeState(m);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, m);
    }
  }, []);

  const toggle = React.useCallback(() => {
    setMode(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setMode]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, toggle }),
    [mode, resolved, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
