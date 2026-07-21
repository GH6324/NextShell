import type { RemoteFileEntry } from "@nextshell/core";

// FileExplorerTable 键盘导航与焦点行的纯函数逻辑。
// 表格数据 files 是原始顺序,实际渲染顺序由 antd Table 内部排序决定;
// 为了让方向键按视觉顺序移动焦点行,这里用同一组 comparator 镜像出展示顺序。

export type FileExplorerSortKey = "name" | "size" | "modifiedAt";
export type FileExplorerSortOrder = "ascend" | "descend";

export interface FileExplorerSort {
  key: FileExplorerSortKey;
  order: FileExplorerSortOrder;
}

export type FileExplorerSortState = FileExplorerSort | null;

// 与 name 列的 defaultSortOrder 保持一致
export const DEFAULT_FILE_EXPLORER_SORT: FileExplorerSortState = {
  key: "name",
  order: "ascend"
};

export const fileExplorerSortComparators: Record<
  FileExplorerSortKey,
  (a: RemoteFileEntry, b: RemoteFileEntry) => number
> = {
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => a.size - b.size,
  modifiedAt: (a, b) => a.modifiedAt.localeCompare(b.modifiedAt)
};

const FILE_EXPLORER_SORT_KEYS: readonly FileExplorerSortKey[] = ["name", "size", "modifiedAt"];

const isFileExplorerSortKey = (key: unknown): key is FileExplorerSortKey =>
  typeof key === "string" && (FILE_EXPLORER_SORT_KEYS as readonly string[]).includes(key);

// 与 antd Table 内部 getSortData 的语义保持一致:
// 稳定排序 + descend 时对比较结果取反(平局项保持原始相对顺序,而不是整体 reverse)。
export const sortRemoteFileEntries = (
  files: readonly RemoteFileEntry[],
  sort: FileExplorerSortState
): RemoteFileEntry[] => {
  if (!sort) return files.slice();
  const comparator = fileExplorerSortComparators[sort.key];
  return files.slice().sort((a, b) => {
    const result = comparator(a, b);
    return sort.order === "descend" ? -result : result;
  });
};

// antd Table onChange 的 sorter 入参中我们只读这两个字段,结构化定义以免 helper 依赖 antd 类型
export interface FileExplorerSorterLike {
  columnKey?: string | number | bigint;
  order?: "ascend" | "descend" | null;
}

// 从 antd onChange 的 sorter 解析当前排序;取消排序(order 为空)时返回 null,与 antd 渲染原始顺序一致
export const resolveFileExplorerSort = (
  sorter: FileExplorerSorterLike | FileExplorerSorterLike[]
): FileExplorerSortState => {
  const active = Array.isArray(sorter) ? sorter[0] : sorter;
  if (!active) return null;
  const { columnKey, order } = active;
  if ((order === "ascend" || order === "descend") && isFileExplorerSortKey(columnKey)) {
    return { key: columnKey, order };
  }
  return null;
};

export type FileExplorerKeyAction = "moveUp" | "moveDown" | "activate" | "parent";

export interface FileExplorerKeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

// 方向键移动焦点行、Enter 打开、Backspace 回上级目录;
// 带 Ctrl/Meta/Alt 的组合键放行给其他快捷键(Shift 不参与,不做范围选择)
export const resolveFileExplorerKeyAction = (
  event: FileExplorerKeyEventLike
): FileExplorerKeyAction | null => {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowUp":
      return "moveUp";
    case "ArrowDown":
      return "moveDown";
    case "Enter":
      return "activate";
    case "Backspace":
      return "parent";
    default:
      return null;
  }
};

export interface FileExplorerKeyboardTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

// 文本编辑类控件(路径输入框、重命名输入等)不抢键盘;
// checkbox/radio(行选择列)不是文本编辑目标,焦点落在其上时方向键仍然可用
export const isEditableKeyboardTarget = (
  target: FileExplorerKeyboardTargetLike | null | undefined
): boolean => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName?.toUpperCase();
  if (tagName === "TEXTAREA" || tagName === "SELECT") return true;
  if (tagName === "INPUT") {
    const type = target.type?.toLowerCase();
    return type !== "checkbox" && type !== "radio";
  }
  return false;
};

// 焦点行移动:无焦点时向下落在第一行、向上落在最后一行;有焦点时在边界内夹取,不回绕
export const moveFocusIndex = (currentIndex: number, delta: number, rowCount: number): number => {
  if (rowCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= rowCount) {
    return delta >= 0 ? 0 : rowCount - 1;
  }
  return Math.min(rowCount - 1, Math.max(0, currentIndex + delta));
};

export type FileExplorerOpenAction =
  | { type: "navigate"; path: string }
  | { type: "edit"; entry: RemoteFileEntry };

// 打开一行的行为(Enter 与双击共用):目录进入,文件/链接交给远程编辑
export const resolveEntryOpenAction = (entry: RemoteFileEntry): FileExplorerOpenAction =>
  entry.type === "directory"
    ? { type: "navigate", path: entry.path }
    : { type: "edit", entry };
