import { useState, useCallback } from "react";

const LS_PREFIX = "revuiw:";

type Updater<T> = T | ((prev: T) => T);

export function useSetting<T>(key: string, fallback: T): [T, (v: Updater<T>) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback((v: Updater<T>) => {
    setValue(prev => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [key]);

  return [value, set];
}
