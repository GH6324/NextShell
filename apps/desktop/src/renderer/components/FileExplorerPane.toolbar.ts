export type FileExplorerToolbarAction =
  | "follow-cwd"
  | "refresh"
  | "back"
  | "forward"
  | "parent"
  | "mkdir"
  | "rename"
  | "delete";

const VISIBLE_FILE_EXPLORER_TOOLBAR_ACTIONS: FileExplorerToolbarAction[] = [
  "follow-cwd",
  "refresh",
  "back",
  "forward",
  "parent",
  "mkdir",
  "rename",
  "delete"
];

export const getVisibleFileExplorerToolbarActions = (): FileExplorerToolbarAction[] => [
  ...VISIBLE_FILE_EXPLORER_TOOLBAR_ACTIONS
];
