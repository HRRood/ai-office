// Names you give people in the office. Stored in this browser only; never sent anywhere.
import { useCallback, useState } from 'react';

const KEY = 'claude-office.names';
export const NAME_MAX = 40;

export type Nicknames = Record<string, string>;

function load(): Nicknames {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === 'object' ? (v as Nicknames) : {};
  } catch {
    return {};
  }
}

function save(n: Nicknames) {
  try {
    localStorage.setItem(KEY, JSON.stringify(n));
  } catch {
    /* storage unavailable: names last until reload */
  }
}

/** [names, rename(id, name)]: an empty name removes the nickname. */
export function useNicknames(): [Nicknames, (id: string, name: string) => void] {
  const [names, setNames] = useState<Nicknames>(load);
  const rename = useCallback((id: string, name: string) => {
    setNames((prev) => {
      const next = { ...prev };
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
      if (clean) next[id] = clean;
      else delete next[id];
      save(next);
      return next;
    });
  }, []);
  return [names, rename];
}
