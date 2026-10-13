/**
 * Minimal external store so the pill label and the popover body can read the same live reading without
 * re-rendering anything else. The observer writes, the surfaces subscribe.
 */
import { useSyncExternalStore } from "react";
import type { AgentTurnSummary, AgentReading } from "./observer";

export interface SurfaceState {
  reading: AgentReading | null;
  lastTurn: AgentTurnSummary | null;
}

export interface ReadingStore {
  get: () => SurfaceState;
  set: (next: Partial<SurfaceState>) => void;
  subscribe: (listener: () => void) => () => void;
}

const EMPTY: SurfaceState = { reading: null, lastTurn: null };

export function createReadingStore(): ReadingStore {
  let value: SurfaceState = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = { ...value, ...next };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useSurfaceState(store: ReadingStore): SurfaceState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
