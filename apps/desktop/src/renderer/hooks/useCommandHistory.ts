import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandHistoryEntry } from "@nextshell/core";
import {
  applyOptimisticCommandHistoryPush,
  applyOptimisticCommandHistoryRemove
} from "./useCommandHistory.helpers";
import { recordCommandHistoryEntry, subscribeCommandHistory } from "./commandHistoryBus";

export type { CommandHistoryEntry };

export const useCommandHistory = () => {
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const navigatorRef = useRef({ index: -1, snapshot: [] as string[] });

  const reload = useCallback(async () => {
    const list = await window.nextshell.commandHistory.list();
    setEntries(list);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Every executed command arrives through the bus, whichever source produced
  // it (input bar submit, or an OSC 133 mark for a command typed straight into
  // the terminal), so the rendered list stays in sync with what was persisted.
  useEffect(
    () =>
      subscribeCommandHistory((command) => {
        const optimisticEntry: CommandHistoryEntry = {
          command,
          useCount: 1,
          lastUsedAt: new Date().toISOString()
        };
        setEntries((prev) => applyOptimisticCommandHistoryPush(prev, optimisticEntry));
        navigatorRef.current = { index: -1, snapshot: [] };
      }),
    []
  );

  const push = useCallback(async (command: string) => {
    recordCommandHistoryEntry(command);
  }, []);

  const remove = useCallback(
    async (command: string) => {
      // Optimistic: remove immediately
      const prev = entries;
      setEntries((current) => applyOptimisticCommandHistoryRemove(current, command));

      try {
        await window.nextshell.commandHistory.remove({ command });
      } catch {
        // Rollback
        setEntries(prev);
      }
    },
    [entries]
  );

  const clear = useCallback(async () => {
    // Optimistic: clear immediately
    const prev = entries;
    setEntries([]);

    try {
      await window.nextshell.commandHistory.clear();
    } catch {
      // Rollback
      setEntries(prev);
    }
  }, [entries]);

  const search = useCallback(
    (query: string): CommandHistoryEntry[] => {
      if (!query.trim()) {
        return entries;
      }

      const lower = query.toLowerCase();
      return entries.filter((e) => e.command.toLowerCase().includes(lower));
    },
    [entries]
  );

  const navigateUp = useCallback((): string | undefined => {
    const nav = navigatorRef.current;
    if (nav.index === -1) {
      nav.snapshot = entries.map((e) => e.command);
    }

    if (nav.snapshot.length === 0) {
      return undefined;
    }

    const nextIndex = Math.min(nav.index + 1, nav.snapshot.length - 1);
    nav.index = nextIndex;
    return nav.snapshot[nextIndex];
  }, [entries]);

  const navigateDown = useCallback((): string | undefined => {
    const nav = navigatorRef.current;
    if (nav.index <= 0) {
      nav.index = -1;
      return "";
    }

    nav.index -= 1;
    return nav.snapshot[nav.index];
  }, []);

  const resetNavigation = useCallback(() => {
    navigatorRef.current = { index: -1, snapshot: [] };
  }, []);

  return useMemo(
    () => ({
      entries,
      push,
      remove,
      clear,
      search,
      navigateUp,
      navigateDown,
      resetNavigation
    }),
    [entries, push, remove, clear, search, navigateUp, navigateDown, resetNavigation]
  );
};
