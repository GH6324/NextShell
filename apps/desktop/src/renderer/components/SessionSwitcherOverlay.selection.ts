/**
 * Pure list resolution for the Ctrl+Tab switcher. The state machine owns a
 * snapshot of session ids taken when the cycle opened; tabs can disappear while
 * the panel is up (remote hang-up closing a pane, an agent closing a tab), so
 * the panel needs the surviving rows plus a selection index that still points
 * inside them. Kept out of the component so the vanishing-row cases are testable
 * without a DOM.
 */

export interface SwitcherSelection<T> {
  /** Rows to render, in the cycle's own order, with vanished ids dropped. */
  entries: T[];
  /** Selected row within `entries`; 0 when nothing survived. */
  selectedIndex: number;
}

/**
 * Map the cycle's id snapshot through `lookup` and clamp the selection.
 *
 * When the selected id is still alive the selection follows it to its new
 * position. When it vanished, the selection falls to where it used to be (the
 * number of surviving rows ahead of it), clamped to the last row — that keeps
 * the highlight next to the tab the user was aiming at instead of jumping to
 * the top of the list.
 */
export const resolveSwitcherSelection = <T>(
  ids: readonly string[],
  index: number,
  lookup: (sessionId: string) => T | undefined
): SwitcherSelection<T> => {
  const entries: T[] = [];
  let selectedIndex = -1;
  let survivorsBeforeSelection = 0;

  for (let position = 0; position < ids.length; position += 1) {
    const id = ids[position];
    const entry = id === undefined ? undefined : lookup(id);
    if (entry === undefined) {
      continue;
    }

    if (position === index) {
      selectedIndex = entries.length;
    } else if (position < index) {
      survivorsBeforeSelection += 1;
    }

    entries.push(entry);
  }

  if (entries.length === 0) {
    return { entries, selectedIndex: 0 };
  }

  if (selectedIndex >= 0) {
    return { entries, selectedIndex };
  }

  return { entries, selectedIndex: Math.min(survivorsBeforeSelection, entries.length - 1) };
};
