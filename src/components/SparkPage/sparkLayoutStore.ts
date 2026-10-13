import { useSyncExternalStore } from "react";

/** Remembered block order for the Sparks page (shared by every Spark). */
export interface SparkLayoutState {
  left: string[];
  right: string[];
}

const STORAGE_KEY = "sparkdash.sparkLayout.v1";
const listeners = new Set<() => void>();
let saved: SparkLayoutState | null = load();

function load(): SparkLayoutState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const ok = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string");
    return ok(v?.left) && ok(v?.right) ? { left: v.left, right: v.right } : null;
  } catch {
    return null;
  }
}

function notify() {
  listeners.forEach((l) => l());
}

export function saveSparkLayout(next: SparkLayoutState) {
  saved = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: layout still holds for this session */
  }
  notify();
}

export function resetSparkLayout() {
  saved = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSparkLayout(): SparkLayoutState | null {
  return useSyncExternalStore(subscribe, () => saved);
}
