import { useState, useCallback, useRef, useEffect } from "react";

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

export function useResize(
  direction: "horizontal",
  opts: { min: number; max: number; initial: number; storageKey?: string }
) {
  const [size, setSize] = useSetting(opts.storageKey || "resize", opts.initial);
  const dragging = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      let newSize: number;
      if (direction === "horizontal") {
        // Caller determines calculation via onCalc
        newSize = e.clientX;
      } else {
        newSize = e.clientY;
      }
      newSize = Math.max(opts.min, Math.min(opts.max, newSize));
      setSize(newSize);
    };

    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [opts.min, opts.max]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return { size, setSize, startDrag, handleRef };
}
