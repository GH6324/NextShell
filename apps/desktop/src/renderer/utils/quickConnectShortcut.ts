interface ShortcutKeyboardLikeEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ContainsLikeTarget {
  contains: (target: any) => boolean;
}

interface EditableLikeTarget {
  tagName?: unknown;
  isContentEditable?: unknown;
}

export const getQuickConnectShortcutLabel = (platform: string): string =>
  platform === "darwin" ? "⌘K" : "Ctrl+K";

export const isQuickConnectShortcut = (
  event: ShortcutKeyboardLikeEvent,
  platform: string
): boolean => {
  const key = event.key.toLowerCase();
  if (key !== "k" || event.altKey || event.shiftKey) {
    return false;
  }

  if (platform === "darwin") {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
};

const isEditableTarget = (target: unknown): target is EditableLikeTarget => {
  if (!target || typeof target !== "object") {
    return false;
  }

  const candidate = target as EditableLikeTarget;
  const tagName = typeof candidate.tagName === "string" ? candidate.tagName.toLowerCase() : "";
  return candidate.isContentEditable === true || tagName === "input" || tagName === "textarea";
};

export const shouldIgnoreQuickConnectShortcutTarget = (
  target: unknown,
  container: ContainsLikeTarget | null
): boolean => {
  if (!isEditableTarget(target)) {
    return false;
  }

  return container ? !container.contains(target) : true;
};
