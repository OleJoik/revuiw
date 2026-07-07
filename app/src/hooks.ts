import { useState, useCallback } from "react";

const LS_PREFIX = "revuiw:";

export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback((v: T) => {
    setValue(v);
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(v));
    } catch {}
  }, [key]);

  return [value, set];
}
