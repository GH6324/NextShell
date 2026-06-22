export type FileExplorerToolbarAction =
  | "back"
  | "forward"
  | "parent"
  | "refresh"
  | "follow-cwd"
  | "upload"
  | "download"
  | "new"
  | "rename"
  | "delete"
  | "paste";

const VISIBLE_FILE_EXPLORER_TOOLBAR_ACTIONS: FileExplorerToolbarAction[] = [
  "back",
  "forward",
  "parent",
  "refresh",
  "follow-cwd",
  "upload",
  "download",
  "new",
  "rename",
  "delete",
  "paste"
];

export const getVisibleFileExplorerToolbarActions = (): FileExplorerToolbarAction[] => [
  ...VISIBLE_FILE_EXPLORER_TOOLBAR_ACTIONS
];
