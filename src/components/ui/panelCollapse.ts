import { useEffect, useSyncExternalStore } from "react";

/**
 * Collapsed state for every <Panel>, shared so the top bar can collapse or
 * expand them all. Keyed by the panel's collapse key (its title by default) and
 * remembered per browser; panels register while mounted so "collapse all" only
 * touches what is on the page.
 */
const STORAGE_KEY = "sparkdash.collapsedPanels";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

let collapsed = load();
const registered = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable: state still works for this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function togglePanel(key: string) {
  collapsed = new Set(collapsed);
  if (!collapsed.delete(key)) collapsed.add(key);
  emit();
}

export function collapseAllPanels() {
  collapsed = new Set([...collapsed, ...registered.keys()]);
  emit();
}

export function expandAllPanels() {
  collapsed = new Set([...collapsed].filter((k) => !registered.has(k)));
  emit();
}

/** Whether this panel is collapsed, and registers it while mounted. */
export function usePanelCollapsed(key: string): boolean {
  useEffect(() => {
    registered.set(key, (registered.get(key) ?? 0) + 1);
    version += 1;
    listeners.forEach((l) => l());
    return () => {
      const n = (registered.get(key) ?? 1) - 1;
      if (n <= 0) registered.delete(key);
      else registered.set(key, n);
      version += 1;
      listeners.forEach((l) => l());
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => collapsed.has(key));
}

/** How many collapsible panels are on the page (0 on pages without any). */
export function useCollapsiblePanelCount(): number {
  useSyncExternalStore(subscribe, () => version);
  return registered.size;
}
