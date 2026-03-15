import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Form, Input, InputNumber, Modal, Radio, Select, Switch, Tooltip } from "antd";
import type { ConnectionProfile, ConnectionImportEntry, SshKeyProfile, ProxyProfile } from "@nextshell/core";
import { CONNECTION_IMPORT_DECRYPT_PROMPT_PREFIX, type ConnectionUpsertInput } from "@nextshell/shared";
import {
  ZONE_ORDER, ZONE_DISPLAY_NAMES, ZONE_ICONS,
  CONNECTION_ZONES, extractZone, isValidZone, getSubPath, buildGroupPath,
  type ConnectionZone
} from "@nextshell/shared";
import { DndContext, DragOverlay, PointerSensor, useSensors, useSensor, useDraggable, useDroppable } from "@dnd-kit/core";
import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import { SshKeyManagerPanel } from "./SshKeyManagerPanel";
import { ProxyManagerPanel } from "./ProxyManagerPanel";
import { ConnectionImportModal } from "./ConnectionImportModal";
import { formatDateTime, formatRelativeTime } from "../utils/formatTime";
import { formatErrorMessage } from "../utils/errorMessage";
import { promptModal } from "../utils/promptModal";

type ManagerTab = "connections" | "keys" | "proxies";

interface ImportPreviewBatch {
  fileName: string;
  entries: ConnectionImportEntry[];
}

interface ConnectionManagerModalProps {
  open: boolean;
  focusConnectionId?: string;
  connections: ConnectionProfile[];
  sshKeys: SshKeyProfile[];
  proxies: ProxyProfile[];
  onClose: () => void;
  onConnectionSaved: (payload: ConnectionUpsertInput) => Promise<void>;
  onConnectConnection: (connectionId: string) => Promise<void>;
  onConnectionRemoved: (connectionId: string) => Promise<void>;
  onConnectionsImported: () => Promise<void>;
  onReloadSshKeys: () => Promise<void>;
  onReloadProxies: () => Promise<void>;
  onOpenLocalTerminal: () => void;
}

const sanitizeOptionalText = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeTextArray = (values: string[] | undefined): string[] => {
  return (values ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

import { enforceZonePrefix } from "@nextshell/shared";

const normalizeGroupPath = (value: string | undefined): string => {
  if (!value) return "/server";
  let path = value.trim().replace(/\\/g, "/");
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return enforceZonePrefix(path || "/server");
};

type FormTab = "basic" | "property" | "network" | "advanced";

const groupKeyToPath = (key: string): string => {
  if (key === "root") return "/";
  const prefix = "mgr-group:";
  const raw = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return "/" + raw;
};

const toQuickUpsertInput = (
  connection: ConnectionProfile,
  patch: Partial<ConnectionUpsertInput>
): ConnectionUpsertInput => ({
  id: connection.id,
  name: connection.name,
  host: connection.host,
  port: connection.port,
  username: connection.username,
  authType: connection.authType,
  sshKeyId: connection.sshKeyId,
  hostFingerprint: connection.hostFingerprint,
  strictHostKeyChecking: connection.strictHostKeyChecking,
  proxyId: connection.proxyId,
  keepAliveEnabled: connection.keepAliveEnabled,
  keepAliveIntervalSec: connection.keepAliveIntervalSec,
  terminalEncoding: connection.terminalEncoding,
  backspaceMode: connection.backspaceMode,
  deleteMode: connection.deleteMode,
  groupPath: connection.groupPath,
  tags: connection.tags,
  notes: connection.notes,
  favorite: connection.favorite,
  monitorSession: connection.monitorSession,
  ...patch
});

/* ── Custom tree types ──────────────────────────────────── */

interface MgrGroupNode {
  type: "group";
  key: string;
  label: string;
  children: MgrTreeNode[];
  /** If set, this node is a fixed zone root */
  zone?: ConnectionZone;
  /** Custom icon class for zone nodes */
  icon?: string;
}

interface MgrLeafNode {
  type: "leaf";
  connection: ConnectionProfile;
}

type MgrTreeNode = MgrGroupNode | MgrLeafNode;

const groupPathToSegments = (groupPath: string): string[] => {
  return groupPath.split("/").filter((s) => s.length > 0);
};

const buildManagerTree = (connections: ConnectionProfile[], keyword: string, emptyFolders?: string[]): MgrGroupNode => {
  const lower = keyword.toLowerCase().trim();
  const root: MgrGroupNode = { type: "group", key: "root", label: "全部连接", children: [] };

  // Create fixed zone nodes
  const zoneNodes = new Map<string, MgrGroupNode>();
  for (const zone of ZONE_ORDER) {
    const node: MgrGroupNode = {
      type: "group",
      key: `mgr-group:${zone}`,
      label: ZONE_DISPLAY_NAMES[zone],
      children: [],
      zone,
      icon: ZONE_ICONS[zone]
    };
    zoneNodes.set(zone, node);
    root.children.push(node);
  }

  const ensureGroup = (zoneNode: MgrGroupNode, subSegments: string[]): MgrGroupNode => {
    let pointer = zoneNode;
    const segments: string[] = [zoneNode.zone!];
    for (const part of subSegments) {
      segments.push(part);
      const key = `mgr-group:${segments.join("/")}`;
      let next = pointer.children.find(
        (n): n is MgrGroupNode => n.type === "group" && n.key === key
      );
      if (!next) {
        next = { type: "group", key, label: part, children: [] };
        pointer.children.push(next);
      }
      pointer = next;
    }
    return pointer;
  };

  for (const connection of connections) {
    const text = `${connection.name} ${connection.host} ${connection.groupPath} ${connection.tags.join(" ")}`.toLowerCase();
    if (lower && !text.includes(lower)) continue;

    const segments = groupPathToSegments(connection.groupPath);
    const zoneName = segments[0] ?? "server";
    const zone = isValidZone(zoneName) ? zoneName : "server";
    const zoneNode = zoneNodes.get(zone)!;
    const subSegments = isValidZone(zoneName) ? segments.slice(1) : segments;

    ensureGroup(zoneNode, subSegments).children.push({ type: "leaf", connection });
  }

  // Insert empty folders (local-only, transient)
  if (emptyFolders) {
    for (const folderPath of emptyFolders) {
      const segments = groupPathToSegments(folderPath);
      const zoneName = segments[0] ?? "server";
      const zone = isValidZone(zoneName) ? zoneName : "server";
      const zoneNode = zoneNodes.get(zone)!;
      const subSegments = isValidZone(zoneName) ? segments.slice(1) : segments;
      ensureGroup(zoneNode, subSegments);
    }
  }

  return root;
};

/** Flatten tree leaves in display order (for Shift-range selection). */
const collectFlatLeafIds = (node: MgrGroupNode, expandedKeys: Set<string>, depth: number): string[] => {
  const ids: string[] = [];
  if (depth > 0 && !expandedKeys.has(node.key)) return ids;
  for (const child of node.children) {
    if (child.type === "leaf") ids.push(child.connection.id);
    else ids.push(...collectFlatLeafIds(child, expandedKeys, depth + 1));
  }
  return ids;
};

/** Recursively collect all leaf IDs under a group. */
const collectGroupLeafIds = (node: MgrGroupNode): string[] => {
  const ids: string[] = [];
  for (const child of node.children) {
    if (child.type === "leaf") ids.push(child.connection.id);
    else ids.push(...collectGroupLeafIds(child));
  }
  return ids;
};

/** Sort tree children: folders first (alphabetical), then connections by mode. */
const sortMgrChildren = (node: MgrGroupNode, mode: "name" | "host" | "createdAt"): MgrGroupNode => {
  const groups: MgrGroupNode[] = [];
  const leaves: MgrLeafNode[] = [];
  for (const child of node.children) {
    if (child.type === "group") groups.push(sortMgrChildren(child, mode));
    else leaves.push(child);
  }
  // Zone nodes keep their ZONE_ORDER; sub-folders sort alphabetically
  if (!node.zone) {
    groups.sort((a, b) => {
      if (a.zone && b.zone) return 0; // keep original zone order
      return a.label.localeCompare(b.label);
    });
  }
  leaves.sort((a, b) => {
    if (mode === "host") return a.connection.host.localeCompare(b.connection.host);
    if (mode === "createdAt") return new Date(a.connection.createdAt).getTime() - new Date(b.connection.createdAt).getTime();
    return a.connection.name.localeCompare(b.connection.name);
  });
  return { ...node, children: [...groups, ...leaves] };
};

const countMgrLeaves = (node: MgrGroupNode): number => {
  let count = 0;
  for (const child of node.children) {
    if (child.type === "leaf") count += 1;
    else count += countMgrLeaves(child);
  }
  return count;
};

/* ── Custom tree sub-components ─────────────────────────── */

const MgrGroupRow = ({
  node,
  expanded,
  onToggle,
  onContextMenu,
  onCtrlClick
}: {
  node: MgrGroupNode;
  expanded: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onCtrlClick?: () => void;
}) => {
  const { isOver, setNodeRef } = useDroppable({ id: node.key });

  const handleClick = (e: React.MouseEvent) => {
    if ((e.metaKey || e.ctrlKey) && onCtrlClick) {
      e.preventDefault();
      onCtrlClick();
      return;
    }
    onToggle();
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`mgr-group-row${isOver ? " mgr-group-row--drop-target" : ""}`}
      onClick={handleClick}
      onContextMenu={onContextMenu}
    >
      <i
        className={expanded ? "ri-arrow-down-s-line" : "ri-arrow-right-s-line"}
        aria-hidden="true"
      />
      <i className={
        node.icon
          ? `${node.icon}`
          : isOver ? "ri-folder-open-line" : "ri-folder-3-line"
      } aria-hidden="true" />
      <span className="mgr-group-label">{node.label}</span>
      <span className="mgr-group-count">{countMgrLeaves(node)}</span>
    </button>
  );
};

const MgrServerRow = ({
  connection,
  isPrimary,
  isMultiSelected,
  isCutPending,
  isRenaming,
  onSelect,
  onDoubleClick,
  onQuickConnect,
  onContextMenu,
  onRenameCommit,
  onRenameCancel
}: {
  connection: ConnectionProfile;
  isPrimary: boolean;
  isMultiSelected: boolean;
  isCutPending: boolean;
  isRenaming: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onQuickConnect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameCommit: (newName: string) => void;
  onRenameCancel: () => void;
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: connection.id,
    data: { connection }
  });

  const renameRef = useRef<HTMLInputElement>(null);

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const val = renameRef.current?.value.trim();
      onRenameCommit(val || connection.name);
    } else if (e.key === "Escape") {
      onRenameCancel();
    }
  };

  const handleRenameBlur = () => {
    const val = renameRef.current?.value.trim();
    onRenameCommit(val || connection.name);
  };

  return (
    <div
      ref={setNodeRef}
      className={
        `mgr-server-row${isPrimary ? " selected" : ""}${isMultiSelected ? " multi-selected" : ""}${isDragging ? " mgr-server-row--dragging" : ""}${isCutPending ? " cut-pending" : ""}`
      }
      {...attributes}
      {...listeners}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="mgr-server-select-btn"
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        title={`${connection.name} (${connection.host}:${connection.port})`}
      >
        <span className="mgr-server-status" />
        {connection.favorite ? (
          <i className="ri-star-fill mgr-server-star" aria-hidden="true" />
        ) : null}
        {isRenaming ? (
          <input
            ref={renameRef}
            className="mgr-server-rename-input"
            defaultValue={connection.name}
            autoFocus
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="mgr-server-name">{connection.name}</span>
        )}
        {connection.originKind === "cloud" && (
          <i className="ri-cloud-line" aria-hidden="true" style={{ fontSize: 12, color: "var(--text-tertiary)", marginLeft: 4 }} />
        )}
        {!isRenaming && <span className="mgr-server-host">{connection.host}</span>}
      </button>
      <button
        type="button"
        className="mgr-quick-connect-btn"
        onClick={onQuickConnect}
        title="快速连接"
        aria-label="快速连接"
      >
        <i className="ri-terminal-box-line" aria-hidden="true" />
      </button>
    </div>
  );
};

const MgrTreeGroup = ({
  node,
  depth,
  expanded,
  toggleExpanded,
  primarySelectedId,
  selectedIds,
  cutIds,
  renamingId,
  onSelect,
  onDoubleClick,
  onQuickConnect,
  onContextMenu,
  onGroupContextMenu,
  onGroupCtrlClick,
  onRenameCommit,
  onRenameCancel
}: {
  node: MgrGroupNode;
  depth: number;
  expanded: Set<string>;
  toggleExpanded: (key: string) => void;
  primarySelectedId: string | undefined;
  selectedIds: Set<string>;
  cutIds: Set<string>;
  renamingId: string | undefined;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onDoubleClick: (connectionId: string) => void;
  onQuickConnect: (connectionId: string) => void;
  onContextMenu: (e: React.MouseEvent, connectionId: string) => void;
  onGroupContextMenu: (e: React.MouseEvent, node: MgrGroupNode) => void;
  onGroupCtrlClick: (node: MgrGroupNode) => void;
  onRenameCommit: (connectionId: string, newName: string) => void;
  onRenameCancel: () => void;
}) => {
  const isExpanded = expanded.has(node.key);
  return (
    <div className="mgr-group">
      {depth > 0 && (
        <MgrGroupRow
          node={node}
          expanded={isExpanded}
          onToggle={() => toggleExpanded(node.key)}
          onContextMenu={(e) => onGroupContextMenu(e, node)}
          onCtrlClick={() => onGroupCtrlClick(node)}
        />
      )}
      {(depth === 0 || isExpanded) && (
        <div className={`mgr-group-children${depth > 0 ? " mgr-group-children--indented" : ""}`}>
          {node.children.map((child) =>
            child.type === "group" ? (
              <MgrTreeGroup
                key={child.key}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                primarySelectedId={primarySelectedId}
                selectedIds={selectedIds}
                cutIds={cutIds}
                renamingId={renamingId}
                onSelect={onSelect}
                onDoubleClick={onDoubleClick}
                onQuickConnect={onQuickConnect}
                onContextMenu={onContextMenu}
                onGroupContextMenu={onGroupContextMenu}
                onGroupCtrlClick={onGroupCtrlClick}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
              />
            ) : (
              <MgrServerRow
                key={child.connection.id}
                connection={child.connection}
                isPrimary={child.connection.id === primarySelectedId}
                isMultiSelected={selectedIds.has(child.connection.id)}
                isCutPending={cutIds.has(child.connection.id)}
                isRenaming={renamingId === child.connection.id}
                onSelect={(e) => onSelect(child.connection.id, e)}
                onDoubleClick={() => onDoubleClick(child.connection.id)}
                onQuickConnect={() => onQuickConnect(child.connection.id)}
                onContextMenu={(e) => onContextMenu(e, child.connection.id)}
                onRenameCommit={(newName) => onRenameCommit(child.connection.id, newName)}
                onRenameCancel={onRenameCancel}
              />
            )
          )}
        </div>
      )}
    </div>
  );
};

/* ── Root drop zone ────────────────────────────────── */

const MgrRootDropZone = ({ children, onContextMenu }: { children: React.ReactNode; onContextMenu?: (e: React.MouseEvent) => void }) => {
  const { isOver, setNodeRef } = useDroppable({ id: "root" });
  return (
    <div
      ref={setNodeRef}
      className={`mgr-tree-wrap${isOver ? " mgr-tree-wrap--drop-target" : ""}`}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
};

/* ── Context menu types ────────────────────────────────── */

type MgrContextTarget =
  | { type: "connection"; connectionId: string }
  | { type: "group"; groupKey: string; groupPath: string }
  | { type: "empty" };

interface MgrContextMenuState {
  x: number;
  y: number;
  target: MgrContextTarget;
}

type MgrClipboard = { mode: "copy" | "cut"; connectionIds: string[] };

interface MgrContextMenuProps {
  state: MgrContextMenuState;
  clipboard: MgrClipboard | null;
  connections: ConnectionProfile[];
  selectedIds: Set<string>;
  sortMode: "name" | "host" | "createdAt";
  onClose: () => void;
  onConnect: (connectionId: string) => void;
  onEdit: (connectionId: string) => void;
  onRename: (connectionId: string) => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: (targetGroupPath: string) => void;
  onDelete: () => void;
  onCopyAddress: (connectionId: string) => void;
  onNewConnection: (groupPath?: string) => void;
  onNewFolder: (parentGroupPath: string) => void;
  onSort: (mode: "name" | "host" | "createdAt") => void;
  onImportNextShell: () => void;
  onImportFinalShell: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
}

const MgrContextMenu = ({
  state,
  clipboard,
  connections,
  selectedIds,
  sortMode,
  onClose,
  onConnect,
  onEdit,
  onRename,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onCopyAddress,
  onNewConnection,
  onNewFolder,
  onSort,
  onImportNextShell,
  onImportFinalShell,
  onExportSelected,
  onExportAll
}: MgrContextMenuProps) => {
  const { x, y, target } = state;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [visible, setVisible] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 4;
    let top = y - h - GAP;
    if (top < GAP) top = y + GAP;
    if (top + h > vh - GAP) top = vh - h - GAP;
    let left = x;
    if (left + w > vw - GAP) left = x - w;
    if (left < GAP) left = GAP;
    setPos({ left, top });
    setVisible(true);
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  const run = (fn: () => void) => { fn(); onClose(); };

  const isConnection = target.type === "connection";
  const conn = isConnection
    ? connections.find((c) => c.id === target.connectionId)
    : undefined;
  const isLocalConn = conn?.originKind !== "cloud";
  const hasPaste = Boolean(clipboard);
  const targetGroupPath = target.type === "group"
    ? target.groupPath
    : target.type === "connection" && conn
      ? conn.groupPath
      : "/server";
  const multiCount = selectedIds.size;

  return (
    <div
      ref={menuRef}
      className="mgr-ctx-menu"
      style={{ left: pos.left, top: pos.top, visibility: visible ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Connection-specific items */}
      {isConnection && conn && (
        <>
          <button className="mgr-ctx-item" onClick={() => run(() => onConnect(conn.id))}>
            <span className="mgr-ctx-icon"><i className="ri-terminal-box-line" aria-hidden="true" /></span> 连接
          </button>
          <button className="mgr-ctx-item" onClick={() => run(() => onEdit(conn.id))}>
            <span className="mgr-ctx-icon"><i className="ri-edit-line" aria-hidden="true" /></span> 编辑
          </button>
          <button className="mgr-ctx-item" onClick={() => run(() => onRename(conn.id))}>
            <span className="mgr-ctx-icon"><i className="ri-pencil-line" aria-hidden="true" /></span> 重命名
          </button>
          <div className="mgr-ctx-divider" />
        </>
      )}

      {/* Copy / Cut / Paste — only for local connections */}
      {(isConnection || target.type === "group" || target.type === "empty") && (
        <>
          {isConnection && isLocalConn && (
            <>
              <button className="mgr-ctx-item" onClick={() => run(onCopy)} disabled={multiCount === 0}>
                <span className="mgr-ctx-icon"><i className="ri-file-copy-line" aria-hidden="true" /></span> 复制
                {multiCount > 1 && <span className="mgr-ctx-badge">{multiCount}</span>}
              </button>
              <button className="mgr-ctx-item" onClick={() => run(onCut)} disabled={multiCount === 0}>
                <span className="mgr-ctx-icon"><i className="ri-scissors-cut-line" aria-hidden="true" /></span> 剪切
                {multiCount > 1 && <span className="mgr-ctx-badge">{multiCount}</span>}
              </button>
            </>
          )}
          <button className="mgr-ctx-item" onClick={() => run(() => onPaste(targetGroupPath))} disabled={!hasPaste}>
            <span className="mgr-ctx-icon"><i className="ri-clipboard-line" aria-hidden="true" /></span> 粘贴
            {hasPaste && clipboard && (
              <span className="mgr-ctx-badge">{clipboard.mode === "copy" ? "复制" : "剪切"}</span>
            )}
          </button>
          {isConnection && <div className="mgr-ctx-divider" />}
        </>
      )}

      {/* Delete */}
      {isConnection && (
        <>
          <button className="mgr-ctx-item mgr-ctx-danger" onClick={() => run(onDelete)}>
            <span className="mgr-ctx-icon"><i className="ri-delete-bin-6-line" aria-hidden="true" /></span> 删除
            {multiCount > 1 && <span className="mgr-ctx-badge">{multiCount}</span>}
          </button>
          <div className="mgr-ctx-divider" />
        </>
      )}

      {/* Copy address */}
      {isConnection && conn && (
        <>
          <button className="mgr-ctx-item" onClick={() => run(() => onCopyAddress(conn.id))}>
            <span className="mgr-ctx-icon"><i className="ri-link-m" aria-hidden="true" /></span> 复制地址
          </button>
          <div className="mgr-ctx-divider" />
        </>
      )}

      {/* New submenu */}
      <div
        className="mgr-ctx-item mgr-ctx-submenu-trigger"
        onMouseEnter={() => setNewOpen(true)}
        onMouseLeave={() => setNewOpen(false)}
      >
        <span className="mgr-ctx-icon"><i className="ri-add-line" aria-hidden="true" /></span> 新建
        <span className="mgr-ctx-arrow">›</span>
        {newOpen && (
          <div className="mgr-ctx-submenu">
            <button className="mgr-ctx-item" onClick={() => run(() => onNewConnection(targetGroupPath))}>
              <span className="mgr-ctx-icon"><i className="ri-terminal-box-line" aria-hidden="true" /></span> SSH连接(Linux)
            </button>
            <button className="mgr-ctx-item" onClick={() => run(() => onNewFolder(targetGroupPath))}>
              <span className="mgr-ctx-icon"><i className="ri-folder-3-line" aria-hidden="true" /></span> 文件夹
            </button>
          </div>
        )}
      </div>

      {/* Sort submenu */}
      <div
        className="mgr-ctx-item mgr-ctx-submenu-trigger"
        onMouseEnter={() => setSortOpen(true)}
        onMouseLeave={() => setSortOpen(false)}
      >
        <span className="mgr-ctx-icon"><i className="ri-sort-asc" aria-hidden="true" /></span> 排序
        <span className="mgr-ctx-arrow">›</span>
        {sortOpen && (
          <div className="mgr-ctx-submenu">
            <button className={`mgr-ctx-item${sortMode === "name" ? " mgr-ctx-active" : ""}`} onClick={() => run(() => onSort("name"))}>
              <span className="mgr-ctx-icon"><i className="ri-sort-alphabet-asc" aria-hidden="true" /></span> 按名称
            </button>
            <button className={`mgr-ctx-item${sortMode === "host" ? " mgr-ctx-active" : ""}`} onClick={() => run(() => onSort("host"))}>
              <span className="mgr-ctx-icon"><i className="ri-global-line" aria-hidden="true" /></span> 按地址
            </button>
            <button className={`mgr-ctx-item${sortMode === "createdAt" ? " mgr-ctx-active" : ""}`} onClick={() => run(() => onSort("createdAt"))}>
              <span className="mgr-ctx-icon"><i className="ri-time-line" aria-hidden="true" /></span> 按创建时间
            </button>
          </div>
        )}
      </div>

      <div className="mgr-ctx-divider" />

      {/* Import submenu */}
      <div
        className="mgr-ctx-item mgr-ctx-submenu-trigger"
        onMouseEnter={() => setImportOpen(true)}
        onMouseLeave={() => setImportOpen(false)}
      >
        <span className="mgr-ctx-icon"><i className="ri-upload-2-line" aria-hidden="true" /></span> 导入
        <span className="mgr-ctx-arrow">›</span>
        {importOpen && (
          <div className="mgr-ctx-submenu">
            <button className="mgr-ctx-item" onClick={() => run(onImportNextShell)}>
              <span className="mgr-ctx-icon"><i className="ri-file-line" aria-hidden="true" /></span> NextShell 文件
            </button>
            <button className="mgr-ctx-item" onClick={() => run(onImportFinalShell)}>
              <span className="mgr-ctx-icon"><i className="ri-file-upload-line" aria-hidden="true" /></span> FinalShell 文件
            </button>
          </div>
        )}
      </div>

      {/* Export submenu */}
      <div
        className="mgr-ctx-item mgr-ctx-submenu-trigger"
        onMouseEnter={() => setExportOpen(true)}
        onMouseLeave={() => setExportOpen(false)}
      >
        <span className="mgr-ctx-icon"><i className="ri-download-2-line" aria-hidden="true" /></span> 导出
        <span className="mgr-ctx-arrow">›</span>
        {exportOpen && (
          <div className="mgr-ctx-submenu">
            <button className="mgr-ctx-item" onClick={() => run(onExportSelected)} disabled={multiCount === 0}>
              <span className="mgr-ctx-icon"><i className="ri-checkbox-multiple-line" aria-hidden="true" /></span> 导出选中
              {multiCount > 0 && <span className="mgr-ctx-badge">{multiCount}</span>}
            </button>
            <button className="mgr-ctx-item" onClick={() => run(onExportAll)} disabled={connections.length === 0}>
              <span className="mgr-ctx-icon"><i className="ri-download-line" aria-hidden="true" /></span> 导出全部
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Constants ──────────────────────────────────────────── */

/** Maps form field names to their containing tab, used to auto-switch on validation error */
const FIELD_TAB_MAP: Record<string, FormTab> = {
  name: "basic",
  host: "basic",
  port: "basic",
  username: "basic",
  authType: "basic",
  sshKeyId: "basic",
  password: "basic",
  hostFingerprint: "basic",
  strictHostKeyChecking: "basic",
  groupPath: "property",
  tags: "property",
  notes: "property",
  favorite: "property",
  proxyId: "network",
  keepAliveEnabled: "network",
  keepAliveIntervalSec: "network",
  monitorSession: "advanced",
  terminalEncoding: "advanced",
  backspaceMode: "advanced",
  deleteMode: "advanced"
};

const DEFAULT_VALUES = {
  port: 22,
  authType: "password" as const,
  strictHostKeyChecking: false,
  terminalEncoding: "utf-8" as const,
  backspaceMode: "ascii-backspace" as const,
  deleteMode: "vt220-delete" as const,
  groupPath: "/server",
  groupZone: CONNECTION_ZONES.SERVER as string,
  groupSubPath: "",
  tags: [],
  favorite: false,
  monitorSession: true
};

/* ── Main component ─────────────────────────────────────── */

export const ConnectionManagerModal = ({
  open,
  focusConnectionId,
  connections,
  sshKeys,
  proxies,
  onClose,
  onConnectionSaved,
  onConnectConnection,
  onConnectionRemoved,
  onConnectionsImported,
  onReloadSshKeys,
  onReloadProxies,
  onOpenLocalTerminal
}: ConnectionManagerModalProps) => {
  const { modal, message } = AntdApp.useApp();
  const [activeTab, setActiveTab] = useState<ManagerTab>("connections");
  const [mode, setMode] = useState<"idle" | "new" | "edit">("idle");
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string>();
  const [selectionAnchorId, setSelectionAnchorId] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root"]));
  const [contextMenu, setContextMenu] = useState<MgrContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<MgrClipboard | null>(null);
  const [renamingId, setRenamingId] = useState<string>();
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<"name" | "host" | "createdAt">("name");
  const [formTab, setFormTab] = useState<FormTab>("basic");
  const [saving, setSaving] = useState(false);
  const [connectingFromForm, setConnectingFromForm] = useState(false);
  const [importingPreview, setImportingPreview] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPreviewQueue, setImportPreviewQueue] = useState<ImportPreviewBatch[]>([]);
  const [importQueueIndex, setImportQueueIndex] = useState(0);
  const [revealedLoginPassword, setRevealedLoginPassword] = useState<string>();
  const [revealingLoginPassword, setRevealingLoginPassword] = useState(false);
  const revealPasswordTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hasCloudWorkspaces, setHasCloudWorkspaces] = useState(false);
  const [form] = Form.useForm<ConnectionUpsertInput>();
  const authType = Form.useWatch("authType", form);
  const keepAliveSetting = Form.useWatch("keepAliveEnabled", form);
  const appliedFocusConnectionIdRef = useRef<string | undefined>(undefined);

  const tree = useMemo(
    () => sortMgrChildren(buildManagerTree(connections, keyword, emptyFolders), sortMode),
    [connections, keyword, emptyFolders, sortMode]
  );
  const hasVisibleConnections = useMemo(
    () => countMgrLeaves(tree) > 0,
    [tree]
  );

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(DEFAULT_VALUES);
    setPrimarySelectedId(undefined);
    setSelectedIds(new Set());
    setSelectionAnchorId(undefined);
    setExpanded(new Set(["root", ...ZONE_ORDER.map((z) => `mgr-group:${z}`)]));
    setMode("idle");
    setFormTab("basic");
    setKeyword("");
    setActiveTab("connections");
    setImportingPreview(false);
    setImportModalOpen(false);
    setImportPreviewQueue([]);
    setImportQueueIndex(0);
    setRevealedLoginPassword(undefined);
    setContextMenu(null);
    setClipboard(null);
    setRenamingId(undefined);
    setEmptyFolders([]);
    setSortMode("name");
    if (revealPasswordTimeoutRef.current) {
      clearTimeout(revealPasswordTimeoutRef.current);
      revealPasswordTimeoutRef.current = undefined;
    }
  }, [form, open]);

  useEffect(() => {
    if (!open) return;
    window.nextshell.cloudSync.workspaceList().then((list) => {
      setHasCloudWorkspaces(list.length > 0);
    }).catch(() => {
      setHasCloudWorkspaces(false);
    });
  }, [open]);

  // Auto-expand all groups when keyword is set
  useMemo(() => {
    if (keyword.trim()) {
      const keys = new Set<string>(["root"]);
      const walk = (node: MgrGroupNode) => {
        keys.add(node.key);
        for (const child of node.children) {
          if (child.type === "group") walk(child);
        }
      };
      walk(tree);
      setExpanded(keys);
    }
  }, [keyword, tree]);

  useEffect(() => {
    if (!open || !authType) return;

    if (authType === "agent") {
      form.setFieldsValue({
        password: undefined,
        sshKeyId: undefined
      });
      return;
    }

    if (authType === "password" || authType === "interactive") {
      form.setFieldValue("sshKeyId", undefined);
      return;
    }

    // privateKey — clear password
    form.setFieldValue("password", undefined);
  }, [authType, form, open]);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === primarySelectedId),
    [connections, primarySelectedId]
  );

  useEffect(() => {
    setRevealedLoginPassword(undefined);
    if (revealPasswordTimeoutRef.current) {
      clearTimeout(revealPasswordTimeoutRef.current);
      revealPasswordTimeoutRef.current = undefined;
    }
  }, [authType, primarySelectedId]);

  useEffect(() => {
    return () => {
      if (revealPasswordTimeoutRef.current) {
        clearTimeout(revealPasswordTimeoutRef.current);
      }
    };
  }, []);

  const selectedExportCount = selectedIds.size;
  const currentImportBatch = importPreviewQueue[importQueueIndex];

  // Compute the set of cut IDs for styling
  const cutIds = useMemo(() => {
    if (!clipboard || clipboard.mode !== "cut") return new Set<string>();
    return new Set(clipboard.connectionIds);
  }, [clipboard]);

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const validIds = new Set(connections.map((connection) => connection.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [connections, selectedIds.size]);

  const applyConnectionToForm = useCallback((connection: ConnectionProfile) => {
    const connZone = extractZone(connection.groupPath);
    const connSubPath = getSubPath(connection.groupPath);
    (form as any).setFieldsValue({
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authType: connection.authType,
      sshKeyId: connection.sshKeyId,
      hostFingerprint: connection.hostFingerprint,
      strictHostKeyChecking: connection.strictHostKeyChecking,
      proxyId: connection.proxyId,
      keepAliveEnabled: connection.keepAliveEnabled,
      keepAliveIntervalSec: connection.keepAliveIntervalSec,
      terminalEncoding: connection.terminalEncoding,
      backspaceMode: connection.backspaceMode,
      deleteMode: connection.deleteMode,
      groupPath: connection.groupPath,
      groupZone: isValidZone(connZone) ? connZone : CONNECTION_ZONES.SERVER,
      groupSubPath: connSubPath,
      tags: connection.tags,
      notes: connection.notes,
      favorite: connection.favorite,
      monitorSession: connection.monitorSession,
      password: undefined
    });
  }, [form]);

  const handleNew = useCallback((prefillGroupPath?: string) => {
    setPrimarySelectedId(undefined);
    form.resetFields();
    form.setFieldsValue(DEFAULT_VALUES);
    if (prefillGroupPath) {
      const zone = extractZone(prefillGroupPath);
      const subPath = getSubPath(prefillGroupPath);
      (form as any).setFieldsValue({
        groupPath: prefillGroupPath,
        groupZone: isValidZone(zone) ? zone : CONNECTION_ZONES.SERVER,
        groupSubPath: subPath
      });
    }
    setFormTab("basic");
    setMode("new");
  }, [form]);

  const handleSelectSingle = useCallback((connectionId: string) => {
    const connection = connections.find((c) => c.id === connectionId);
    if (!connection) return;
    const expandedKeys = new Set<string>(["root"]);
    const parts = groupPathToSegments(connection.groupPath);
    const segments: string[] = [];
    for (const part of parts) {
      segments.push(part);
      expandedKeys.add(`mgr-group:${segments.join("/")}`);
    }
    setExpanded(expandedKeys);
    setPrimarySelectedId(connectionId);
    setSelectedIds(new Set([connectionId]));
    setSelectionAnchorId(connectionId);
    applyConnectionToForm(connection);
    setMode("edit");
  }, [connections, applyConnectionToForm]);

  const handleMultiSelect = useCallback((connectionId: string, e: React.MouseEvent) => {
    const connection = connections.find((c) => c.id === connectionId);
    if (!connection) return;

    if (e.shiftKey && selectionAnchorId) {
      // Range select
      const flatIds = collectFlatLeafIds(tree, expanded, 0);
      const anchorIdx = flatIds.indexOf(selectionAnchorId);
      const currentIdx = flatIds.indexOf(connectionId);
      if (anchorIdx >= 0 && currentIdx >= 0) {
        const start = Math.min(anchorIdx, currentIdx);
        const end = Math.max(anchorIdx, currentIdx);
        const rangeIds = flatIds.slice(start, end + 1);
        setSelectedIds(new Set(rangeIds));
        setPrimarySelectedId(connectionId);
        applyConnectionToForm(connection);
        setMode("edit");
        return;
      }
    }

    if (e.metaKey || e.ctrlKey) {
      // Toggle
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(connectionId)) next.delete(connectionId);
        else next.add(connectionId);
        return next;
      });
      setPrimarySelectedId(connectionId);
      setSelectionAnchorId(connectionId);
      applyConnectionToForm(connection);
      setMode("edit");
      return;
    }

    // Plain click
    setSelectedIds(new Set([connectionId]));
    setPrimarySelectedId(connectionId);
    setSelectionAnchorId(connectionId);
    applyConnectionToForm(connection);
    setMode("edit");
  }, [connections, applyConnectionToForm, selectionAnchorId, tree, expanded]);

  useEffect(() => {
    if (!open) {
      appliedFocusConnectionIdRef.current = undefined;
      return;
    }

    if (!focusConnectionId || appliedFocusConnectionIdRef.current === focusConnectionId) {
      return;
    }

    setActiveTab("connections");
    setKeyword("");
    handleSelectSingle(focusConnectionId);
    appliedFocusConnectionIdRef.current = focusConnectionId;
  }, [focusConnectionId, handleSelectSingle, open]);

  const handleReset = useCallback(() => {
    if (selectedConnection) {
      applyConnectionToForm(selectedConnection);
    } else {
      form.resetFields();
      form.setFieldsValue(DEFAULT_VALUES);
    }
  }, [applyConnectionToForm, form, selectedConnection]);

  const handleDelete = useCallback(() => {
    const idsToDelete = selectedIds.size > 0 ? Array.from(selectedIds) : (primarySelectedId ? [primarySelectedId] : []);
    if (idsToDelete.length === 0) return;

    const names = idsToDelete.map((id) => connections.find((c) => c.id === id)?.name ?? id);
    const content = idsToDelete.length === 1
      ? `删除「${names[0]}」后会关闭相关会话，是否继续？`
      : `确认删除 ${idsToDelete.length} 个连接？删除后会关闭相关会话。`;

    Modal.confirm({
      title: "确认删除",
      content,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const id of idsToDelete) {
          await onConnectionRemoved(id);
        }
        setPrimarySelectedId(undefined);
        setSelectedIds(new Set());
        form.resetFields();
        form.setFieldsValue(DEFAULT_VALUES);
        setMode("idle");
      }
    });
  }, [connections, form, onConnectionRemoved, primarySelectedId, selectedIds]);

  const handleCloseForm = useCallback(() => {
    setMode("idle");
    setPrimarySelectedId(undefined);
  }, []);

  const saveConnection = useCallback(async (values: ConnectionUpsertInput & { groupZone?: string; groupSubPath?: string }): Promise<string | undefined> => {
    const password = sanitizeOptionalText(values.password);
    const hostFingerprint = sanitizeOptionalText(values.hostFingerprint);
    // Combine zone selector + sub-path into the final groupPath
    const zone = (values.groupZone && isValidZone(values.groupZone) ? values.groupZone : CONNECTION_ZONES.SERVER) as ConnectionZone;
    const subPath = values.groupSubPath ?? "";
    const groupPath = normalizeGroupPath(buildGroupPath(zone, subPath));
    const tags = sanitizeTextArray(values.tags);
    const notes = sanitizeOptionalText(values.notes);
    // InputNumber may return null when cleared; coerce safely
    const rawPort = values.port as unknown as number | null | undefined;
    const port = rawPort == null ? NaN : Number(rawPort);
    const host = values.host.trim();
    const name = sanitizeOptionalText(values.name) ?? `${host}:${port}`;
    const terminalEncoding = values.terminalEncoding ?? "utf-8";
    const backspaceMode = values.backspaceMode ?? "ascii-backspace";
    const deleteMode = values.deleteMode ?? "vt220-delete";
    const rawKeepAliveInterval = values.keepAliveIntervalSec as unknown as number | null | undefined;
    const keepAliveIntervalSec = rawKeepAliveInterval == null ? undefined : Number(rawKeepAliveInterval);
    const keepAliveEnabled = values.keepAliveEnabled ?? undefined;

    if (extractZone(groupPath) === CONNECTION_ZONES.WORKSPACE && !hasCloudWorkspaces) {
      message.warning("请先在设置中配置云同步工作区");
      return undefined;
    }

    if (values.authType === "privateKey" && !values.sshKeyId) {
      message.error("私钥认证需要选择一个 SSH 密钥。");
      setFormTab("basic");
      return undefined;
    }

    if (values.strictHostKeyChecking && !hostFingerprint) {
      message.error("启用严格主机校验时必须填写主机指纹。");
      setFormTab("basic");
      return undefined;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      message.error("端口必须是 1-65535 的整数。");
      setFormTab("basic");
      return undefined;
    }

    if (!host) {
      message.error("请填写主机地址（在「基本」标签页）。");
      setFormTab("basic");
      return undefined;
    }

    if (
      keepAliveIntervalSec !== undefined &&
      (!Number.isInteger(keepAliveIntervalSec) || keepAliveIntervalSec < 5 || keepAliveIntervalSec > 600)
    ) {
      message.error("Keepalive 间隔需为 5-600 秒的整数。");
      setFormTab("network");
      return undefined;
    }
    const username = (values.username ?? "").trim();

    setSaving(true);
    try {
      const payload: ConnectionUpsertInput = {
        id: values.id ?? primarySelectedId ?? crypto.randomUUID(),
        name,
        host,
        port,
        username,
        authType: values.authType,
        password,
        sshKeyId: values.authType === "privateKey" ? values.sshKeyId : undefined,
        hostFingerprint,
        strictHostKeyChecking: values.strictHostKeyChecking ?? false,
        proxyId: values.proxyId,
        keepAliveEnabled,
        keepAliveIntervalSec,
        terminalEncoding,
        backspaceMode,
        deleteMode,
        tags,
        groupPath,
        notes,
        favorite: values.favorite ?? false,
        monitorSession: values.monitorSession ?? false
      };
      await onConnectionSaved(payload);
      message.success(primarySelectedId ? "连接已更新" : "连接已创建");
      setPrimarySelectedId(payload.id);
      setMode("edit");
      form.setFieldsValue({
        password: undefined
      });
      return payload.id;
    } catch (error) {
      message.error(`保存连接失败：${formatErrorMessage(error, "请检查输入内容")}`);
      return undefined;
    } finally {
      setSaving(false);
    }
  }, [form, hasCloudWorkspaces, onConnectionSaved, primarySelectedId, setFormTab]);

  const handleSaveAndConnect = useCallback(async () => {
    if (saving || connectingFromForm) {
      return;
    }

    let values: ConnectionUpsertInput;
    try {
      values = await form.validateFields();
    } catch (errorInfo) {
      const firstField = String(
        (errorInfo as { errorFields?: Array<{ name: Array<string | number> }> })
          ?.errorFields?.[0]?.name?.[0] ?? ""
      );
      const errTab = FIELD_TAB_MAP[firstField];
      if (errTab) setFormTab(errTab);
      return;
    }

    const connectionId = await saveConnection(values);
    if (!connectionId) {
      return;
    }

    setConnectingFromForm(true);
    try {
      await onConnectConnection(connectionId);
      onClose();
    } finally {
      setConnectingFromForm(false);
    }
  }, [connectingFromForm, form, onClose, onConnectConnection, saveConnection, saving, setFormTab]);

  const handleQuickConnect = useCallback(async (connectionId: string) => {
    await onConnectConnection(connectionId);
    onClose();
  }, [onConnectConnection, onClose]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ── Drag-and-drop (dnd-kit) ─────────────────────── */
  const [draggingConnection, setDraggingConnection] = useState<ConnectionProfile | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const conn = (event.active.data.current as { connection: ConnectionProfile } | undefined)?.connection;
    if (conn) setDraggingConnection(conn);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setDraggingConnection(null);
    const overId = event.over?.id as string | undefined;
    if (!overId) return;

    const conn = (event.active.data.current as { connection: ConnectionProfile } | undefined)?.connection;
    if (!conn) return;

    const targetPath = groupKeyToPath(overId);
    const safePath = enforceZonePrefix(targetPath);

    if (extractZone(safePath) === CONNECTION_ZONES.WORKSPACE && !hasCloudWorkspaces) {
      message.warning("请先在设置中配置云同步工作区");
      return;
    }

    // Determine which connections to move: if dragging one that's in selectedIds
    // and there are multiple selected, move them all
    const connectionsToMove = selectedIds.has(conn.id) && selectedIds.size > 1
      ? connections.filter((c) => selectedIds.has(c.id) && c.groupPath !== safePath)
      : (conn.groupPath !== safePath ? [conn] : []);

    if (connectionsToMove.length === 0) return;

    try {
      for (const c of connectionsToMove) {
        await onConnectionSaved(toQuickUpsertInput(c, { groupPath: safePath }));
      }
      const targetZone = extractZone(safePath);
      const displayName = isValidZone(targetZone) ? ZONE_DISPLAY_NAMES[targetZone] : targetZone;
      message.success(
        connectionsToMove.length === 1
          ? `已移动到 ${displayName}${getSubPath(safePath) || ""}`
          : `已移动 ${connectionsToMove.length} 个连接到 ${displayName}${getSubPath(safePath) || ""}`
      );
      if (primarySelectedId && connectionsToMove.some((c) => c.id === primarySelectedId)) {
        form.setFieldValue("groupPath", safePath);
        (form as any).setFieldValue("groupZone", isValidZone(targetZone) ? targetZone : CONNECTION_ZONES.SERVER);
        (form as any).setFieldValue("groupSubPath", getSubPath(safePath));
      }
    } catch (error) {
      message.error(`移动连接失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  }, [connections, form, hasCloudWorkspaces, onConnectionSaved, primarySelectedId, selectedIds]);

  const getCachedMasterPassword = useCallback(async (): Promise<string> => {
    try {
      const result = await window.nextshell.masterPassword.getCached();
      return result.password ?? "";
    } catch {
      return "";
    }
  }, []);

  const promptExportMode = useCallback((): Promise<"plain" | "encrypted" | null> => {
    return new Promise((resolve) => {
      let mode: "plain" | "encrypted" = "plain";
      let settled = false;
      const settle = (value: "plain" | "encrypted" | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.confirm({
        title: "导出选项",
        okText: "继续",
        cancelText: "取消",
        content: (
          <Radio.Group
            defaultValue="plain"
            onChange={(event) => {
              mode = event.target.value;
            }}
          >
            <Radio value="plain">普通导出（JSON）</Radio>
            <Radio value="encrypted">加密导出（AES + b64##）</Radio>
          </Radio.Group>
        ),
        onOk: () => settle(mode),
        onCancel: () => settle(null)
      });
    });
  }, [modal]);

  const promptExportEncryptionPassword = useCallback((defaultPassword?: string): Promise<string | null> => {
    return new Promise((resolve) => {
      let password = defaultPassword ?? "";
      let confirmPassword = defaultPassword ?? "";
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.confirm({
        title: "输入导出加密密码",
        okText: "确认",
        cancelText: "取消",
        content: (
          <div style={{ display: "grid", gap: 8 }}>
            {defaultPassword ? (
              <div style={{ fontSize: 12, color: "var(--t3)" }}>
                已自动填充主密码，可按需修改。
              </div>
            ) : null}
            <Input.Password
              placeholder="请输入密码（至少 6 位）"
              defaultValue={defaultPassword}
              onChange={(event) => {
                password = event.target.value;
              }}
            />
            <Input.Password
              placeholder="请再次输入密码"
              defaultValue={defaultPassword}
              onChange={(event) => {
                confirmPassword = event.target.value;
              }}
            />
          </div>
        ),
        onOk: async () => {
          const trimmedPassword = password.trim();
          const trimmedConfirm = confirmPassword.trim();
          if (trimmedPassword.length < 6) {
            message.warning("导出加密密码至少需要 6 个字符。");
            throw new Error("invalid-export-password-length");
          }
          if (trimmedPassword !== trimmedConfirm) {
            message.warning("两次输入的密码不一致。");
            throw new Error("invalid-export-password-confirm");
          }
          settle(trimmedPassword);
        },
        onCancel: () => settle(null)
      });
    });
  }, [modal]);

  const runSingleExport = useCallback(
    async (exportIds: string[]): Promise<void> => {
      if (exportIds.length === 0) return;

      const mode = await promptExportMode();
      if (!mode) return;

      let encryptionPassword: string | undefined;
      if (mode === "encrypted") {
        const defaultPassword = await getCachedMasterPassword();
        const password = await promptExportEncryptionPassword(defaultPassword);
        if (!password) return;
        encryptionPassword = password;
      }

      try {
        const result = await window.nextshell.connection.exportToFile({
          connectionIds: exportIds,
          encryptionPassword
        });
        if (result.ok) {
          if (mode === "encrypted") {
            message.success(`已加密导出 ${exportIds.length} 个连接`);
          } else {
            message.success(`已导出 ${exportIds.length} 个连接`);
          }
        }
      } catch (error) {
        message.error(`导出失败：${formatErrorMessage(error, "请稍后重试")}`);
      }
    },
    [getCachedMasterPassword, promptExportEncryptionPassword, promptExportMode]
  );

  const handleExportAll = useCallback(async () => {
    if (connections.length === 0) return;
    await runSingleExport(connections.map((connection) => connection.id));
  }, [connections, runSingleExport]);

  // ── Context menu actions ────────────────────────────
  const handleConnectionContextMenu = useCallback((e: React.MouseEvent, connectionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Ensure right-clicked item is in selection
    if (!selectedIds.has(connectionId)) {
      setSelectedIds(new Set([connectionId]));
      setPrimarySelectedId(connectionId);
      setSelectionAnchorId(connectionId);
      const conn = connections.find((c) => c.id === connectionId);
      if (conn) {
        applyConnectionToForm(conn);
        setMode("edit");
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, target: { type: "connection", connectionId } });
  }, [applyConnectionToForm, connections, selectedIds]);

  const handleGroupContextMenu = useCallback((e: React.MouseEvent, node: MgrGroupNode) => {
    e.preventDefault();
    e.stopPropagation();
    const groupPath = groupKeyToPath(node.key);
    setContextMenu({ x: e.clientX, y: e.clientY, target: { type: "group", groupKey: node.key, groupPath } });
  }, []);

  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    // Only trigger if not clicking on a child element
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, target: { type: "empty" } });
  }, []);

  const handleGroupCtrlClick = useCallback((node: MgrGroupNode) => {
    const leafIds = collectGroupLeafIds(node);
    setSelectedIds((prev) => {
      const allSelected = leafIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of leafIds) next.delete(id);
      } else {
        for (const id of leafIds) next.add(id);
      }
      return next;
    });
  }, []);

  const handleCtxCopy = useCallback(() => {
    const ids = Array.from(selectedIds).filter((id) => {
      const c = connections.find((conn) => conn.id === id);
      return c && c.originKind !== "cloud";
    });
    if (ids.length === 0) return;
    setClipboard({ mode: "copy", connectionIds: ids });
    message.success(`已复制 ${ids.length} 个连接`);
  }, [connections, selectedIds]);

  const handleCtxCut = useCallback(() => {
    const ids = Array.from(selectedIds).filter((id) => {
      const c = connections.find((conn) => conn.id === id);
      return c && c.originKind !== "cloud";
    });
    if (ids.length === 0) return;
    setClipboard({ mode: "cut", connectionIds: ids });
    message.success(`已剪切 ${ids.length} 个连接`);
  }, [connections, selectedIds]);

  const handleCtxPaste = useCallback(async (targetGroupPath: string) => {
    if (!clipboard) return;
    const safePath = enforceZonePrefix(targetGroupPath);
    if (extractZone(safePath) === CONNECTION_ZONES.WORKSPACE && !hasCloudWorkspaces) {
      message.warning("请先在设置中配置云同步工作区");
      return;
    }
    try {
      if (clipboard.mode === "copy") {
        for (const sourceId of clipboard.connectionIds) {
          await window.nextshell.resourceOps.copyConnection({
            sourceId,
            targetOriginKind: "local",
            targetGroupSubPath: getSubPath(safePath) || undefined
          });
        }
        message.success(`已粘贴 ${clipboard.connectionIds.length} 个连接`);
        await onConnectionsImported();
      } else {
        // cut = move
        for (const connId of clipboard.connectionIds) {
          const conn = connections.find((c) => c.id === connId);
          if (conn) {
            await onConnectionSaved(toQuickUpsertInput(conn, { groupPath: safePath }));
          }
        }
        message.success(`已移动 ${clipboard.connectionIds.length} 个连接`);
        setClipboard(null);
      }
    } catch (error) {
      message.error(`粘贴失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  }, [clipboard, connections, hasCloudWorkspaces, onConnectionSaved, onConnectionsImported]);

  const handleCtxCopyAddress = useCallback((connectionId: string) => {
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) return;
    const address = `${conn.host}:${conn.port}`;
    void navigator.clipboard.writeText(address);
    message.success(`已复制地址：${address}`);
  }, [connections]);

  const handleCtxNewFolder = useCallback(async (parentGroupPath: string) => {
    const name = await promptModal(modal, "新建文件夹", "请输入文件夹名称");
    if (!name) return;
    if (name.includes("/") || name.includes("\\")) {
      message.error("文件夹名称不能包含 / 或 \\");
      return;
    }
    const safePath = enforceZonePrefix(parentGroupPath);
    const folderPath = `${safePath}/${name}`;
    setEmptyFolders((prev) => [...prev, folderPath]);
    // Expand parent
    const parentKey = safePath === "/" ? "root" : `mgr-group:${safePath.slice(1)}`;
    const folderKey = `mgr-group:${folderPath.slice(1)}`;
    setExpanded((prev) => new Set([...prev, parentKey, folderKey]));
    message.success(`已创建文件夹「${name}」`);
  }, [modal]);

  const handleCtxRename = useCallback((connectionId: string) => {
    setRenamingId(connectionId);
  }, []);

  const handleRenameCommit = useCallback(async (connectionId: string, newName: string) => {
    setRenamingId(undefined);
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn || conn.name === newName) return;
    try {
      await onConnectionSaved(toQuickUpsertInput(conn, { name: newName }));
      message.success(`已重命名为「${newName}」`);
    } catch (error) {
      message.error(`重命名失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  }, [connections, onConnectionSaved]);

  const handleRenameCancel = useCallback(() => {
    setRenamingId(undefined);
  }, []);

  const handleExportSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const exportIds = connections
      .map((connection) => connection.id)
      .filter((id) => selectedIds.has(id));
    if (exportIds.length === 0) return;

    const mode = await promptExportMode();
    if (!mode) return;

    let encryptionPassword: string | undefined;
    if (mode === "encrypted") {
      const defaultPassword = await getCachedMasterPassword();
      const password = await promptExportEncryptionPassword(defaultPassword);
      if (!password) return;
      encryptionPassword = password;
    }

    const directory = await window.nextshell.dialog.openDirectory({
      title: "选择导出目录"
    });
    if (directory.canceled || !directory.filePath) {
      return;
    }

    try {
      const result = await window.nextshell.connection.exportBatch({
        connectionIds: exportIds,
        directoryPath: directory.filePath,
        encryptionPassword
      });

      if (result.failed === 0) {
        if (mode === "encrypted") {
          message.success(`已加密导出 ${result.exported} 个连接到目录：${result.directoryPath}`);
        } else {
          message.success(`已导出 ${result.exported} 个连接到目录：${result.directoryPath}`);
        }
        return;
      }

      if (result.exported > 0) {
        message.warning(`已导出 ${result.exported}/${result.total}，失败 ${result.failed}`);
      } else {
        message.error(`导出失败：共 ${result.failed} 个连接导出失败`);
      }

      const maxWarnings = 5;
      result.errors.slice(0, maxWarnings).forEach((errorText) => {
        message.warning(formatErrorMessage(errorText, "导出失败"));
      });
      if (result.errors.length > maxWarnings) {
        message.warning(`其余 ${result.errors.length - maxWarnings} 项导出失败`);
      }
    } catch (error) {
      message.error(`导出失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  }, [connections, getCachedMasterPassword, promptExportEncryptionPassword, promptExportMode, selectedIds]);

  const promptMasterPasswordForReveal = useCallback((defaultPassword?: string): Promise<string | null> => {
    return new Promise((resolve) => {
      let password = defaultPassword ?? "";
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.confirm({
        title: "输入主密码查看登录密码",
        okText: "查看",
        cancelText: "取消",
        content: (
          <div style={{ display: "grid", gap: 8 }}>
            {defaultPassword ? (
              <div style={{ fontSize: 12, color: "var(--t3)" }}>
                已自动填充主密码，可按需修改。
              </div>
            ) : null}
            <Input.Password
              placeholder="请输入主密码"
              defaultValue={defaultPassword}
              onChange={(event) => {
                password = event.target.value;
              }}
            />
          </div>
        ),
        onOk: async () => {
          const trimmed = password.trim();
          if (!trimmed) {
            message.warning("请输入主密码。");
            throw new Error("empty-master-password");
          }
          settle(trimmed);
        },
        onCancel: () => settle(null)
      });
    });
  }, [modal]);

  const handleRevealConnectionPassword = useCallback(async () => {
    if (!selectedConnection || !primarySelectedId) {
      return;
    }
    if (selectedConnection.authType !== "password" && selectedConnection.authType !== "interactive") {
      message.warning("仅密码或交互式认证连接支持查看登录密码。");
      return;
    }

    const defaultMasterPassword = await getCachedMasterPassword();
    const inputPassword = await promptMasterPasswordForReveal(defaultMasterPassword);
    if (!inputPassword) {
      return;
    }

    try {
      setRevealingLoginPassword(true);
      const result = await window.nextshell.connection.revealPassword({
        connectionId: primarySelectedId,
        masterPassword: inputPassword
      });
      setRevealedLoginPassword(result.password);
      if (revealPasswordTimeoutRef.current) {
        clearTimeout(revealPasswordTimeoutRef.current);
      }
      revealPasswordTimeoutRef.current = setTimeout(() => {
        setRevealedLoginPassword(undefined);
        revealPasswordTimeoutRef.current = undefined;
      }, 30_000);
      message.success("已显示登录密码，30 秒后自动隐藏。");
    } catch (error) {
      message.error(`查看登录密码失败：${formatErrorMessage(error, "请检查主密码")}`);
    } finally {
      setRevealingLoginPassword(false);
    }
  }, [
    getCachedMasterPassword,
    promptMasterPasswordForReveal,
    selectedConnection,
    primarySelectedId
  ]);

  const resetImportFlow = useCallback(() => {
    setImportModalOpen(false);
    setImportPreviewQueue([]);
    setImportQueueIndex(0);
  }, []);

  const getFileName = useCallback((filePath: string): string => {
    const normalized = filePath.replace(/\\/g, "/");
    const splitIndex = normalized.lastIndexOf("/");
    if (splitIndex < 0) {
      return normalized;
    }
    return normalized.slice(splitIndex + 1);
  }, []);

  const promptImportDecryptionPassword = useCallback(
    (fileName: string, promptText: string): Promise<string | null> => {
      return new Promise((resolve) => {
        let password = "";
        let settled = false;
        const settle = (value: string | null): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        modal.confirm({
          title: `${fileName} 需要解密密码`,
          okText: "解密",
          cancelText: "跳过该文件",
          content: (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--t3)" }}>{promptText}</div>
              <Input.Password
                placeholder="请输入导入密码"
                onChange={(event) => {
                  password = event.target.value;
                }}
              />
            </div>
          ),
          onOk: async () => {
            const trimmed = password.trim();
            if (!trimmed) {
              message.warning("请输入解密密码。");
              throw new Error("empty-import-password");
            }
            settle(trimmed);
          },
          onCancel: () => settle(null)
        });
      });
    },
    [modal]
  );

  const loadImportPreviewQueue = useCallback(async (source: "nextshell" | "finalshell") => {
    if (importingPreview) return;
    try {
      setImportingPreview(true);
      const dialogResult = await window.nextshell.dialog.openFiles({
        title: source === "nextshell" ? "选择 NextShell 导入文件" : "选择 FinalShell 配置文件",
        multi: true
      });
      if (dialogResult.canceled || dialogResult.filePaths.length === 0) return;

      const queue: ImportPreviewBatch[] = [];
      const warnings: string[] = [];

      for (const filePath of dialogResult.filePaths) {
        const fileName = getFileName(filePath);
        if (source === "nextshell") {
          let decryptionPassword: string | undefined;
          let handled = false;

          while (!handled) {
            try {
              const entries = await window.nextshell.connection.importPreview({
                filePath,
                decryptionPassword
              });
              if (entries.length === 0) {
                warnings.push(`${fileName}：文件中没有可导入的连接`);
              } else {
                queue.push({ fileName, entries });
              }
              handled = true;
            } catch (error) {
              const reason = formatErrorMessage(error, "导入预览失败");
              if (reason.startsWith(CONNECTION_IMPORT_DECRYPT_PROMPT_PREFIX)) {
                const promptText =
                  reason.slice(CONNECTION_IMPORT_DECRYPT_PROMPT_PREFIX.length).trim()
                  || "该导入文件已加密，请输入密码";
                const inputPassword = await promptImportDecryptionPassword(fileName, promptText);
                if (!inputPassword) {
                  warnings.push(`${fileName}：用户取消解密，已跳过该文件`);
                  handled = true;
                  continue;
                }
                decryptionPassword = inputPassword;
                continue;
              }

              warnings.push(`${fileName}：${formatErrorMessage(reason, "导入预览失败")}`);
              handled = true;
            }
          }
          continue;
        }

        try {
          const entries = await window.nextshell.connection.importFinalShellPreview({
            filePath
          });
          if (entries.length === 0) {
            warnings.push(`${fileName}：文件中没有可导入的连接`);
          } else {
            queue.push({ fileName, entries });
          }
        } catch (error) {
          warnings.push(`${fileName}：${formatErrorMessage(error, "导入预览失败")}`);
        }
      }

      if (warnings.length > 0) {
        warnings.forEach((item) => {
          message.warning(formatErrorMessage(item, "部分文件导入失败"));
        });
      }

      if (queue.length === 0) {
        message.warning(
          source === "nextshell"
            ? "未找到可导入的 NextShell 连接文件"
            : "未找到可导入的 FinalShell 连接文件"
        );
        return;
      }

      setImportPreviewQueue(queue);
      setImportQueueIndex(0);
      setImportModalOpen(true);
      if (queue.length > 1) {
        message.info(`已加载 ${queue.length} 个文件，将按文件逐个导入`);
      }
    } catch (error) {
      message.error(`导入预览失败：${formatErrorMessage(error, "请检查文件格式")}`);
    } finally {
      setImportingPreview(false);
    }
  }, [getFileName, importingPreview, promptImportDecryptionPassword]);

  const handleImportNextShell = useCallback(async () => {
    await loadImportPreviewQueue("nextshell");
  }, [loadImportPreviewQueue]);

  const handleImportFinalShell = useCallback(async () => {
    await loadImportPreviewQueue("finalshell");
  }, [loadImportPreviewQueue]);

  const handleImportBatchImported = useCallback(async () => {
    await onConnectionsImported();
    const nextIndex = importQueueIndex + 1;
    if (nextIndex < importPreviewQueue.length) {
      setImportQueueIndex(nextIndex);
      const nextBatch = importPreviewQueue[nextIndex];
      message.info(`继续导入 ${nextBatch?.fileName ?? "下一个文件"} (${nextIndex + 1}/${importPreviewQueue.length})`);
      return;
    }

    resetImportFlow();
  }, [importPreviewQueue, importQueueIndex, onConnectionsImported, resetImportFlow]);

  return (
    <>
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      style={{ top: 48 }}
      styles={{
        header: { padding: "13px 18px", marginBottom: 0, borderBottom: "1px solid var(--border)" },
        body: { padding: 0, overflow: "hidden" },
      }}
      title={<span className="mgr-modal-title">连接管理器</span>}
      destroyOnHidden
    >
      {/* ── Tab bar ───────────────────────────── */}
      <div className="mgr-tab-bar">
        <button
          type="button"
          className={`mgr-tab${activeTab === "connections" ? " mgr-tab--active" : ""}`}
          onClick={() => setActiveTab("connections")}
        >
          <i className="ri-server-line" aria-hidden="true" />
          连接
        </button>
        <button
          type="button"
          className={`mgr-tab${activeTab === "keys" ? " mgr-tab--active" : ""}`}
          onClick={() => setActiveTab("keys")}
        >
          <i className="ri-key-2-line" aria-hidden="true" />
          密钥
        </button>
        <button
          type="button"
          className={`mgr-tab${activeTab === "proxies" ? " mgr-tab--active" : ""}`}
          onClick={() => setActiveTab("proxies")}
        >
          <i className="ri-shield-line" aria-hidden="true" />
          代理
        </button>
      </div>

      {/* ── Connections tab ───────────────────── */}
      {activeTab === "connections" && (
      <div className="mgr-connections-layout">

        {/* ── Sidebar ─────────────────────────── */}
        <div className="mgr-sidebar">

          {/* Sidebar header */}
          <div className="mgr-sidebar-head">
            <div className="mgr-sidebar-title-row">
              <span className="mgr-sidebar-title">全部连接</span>
              {connections.length > 0 && (
                <span className="mgr-count-badge">{connections.length}</span>
              )}
            </div>
            <div className="mgr-sidebar-title-row">
              <button
                className="mgr-new-btn"
                onClick={() => { onOpenLocalTerminal(); onClose(); }}
                title="本地终端"
              >
                <i className="ri-terminal-box-line" aria-hidden="true" />
              </button>
              <button
                className="mgr-new-btn"
                onClick={() => handleNew()}
                title="新建连接"
              >
                <i className="ri-add-line" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="mgr-search-row">
            <i className="ri-search-line mgr-search-icon" aria-hidden="true" />
            <input
              className="mgr-search"
              placeholder="搜索连接..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            {keyword && (
              <button
                className="mgr-search-clear"
                onClick={() => setKeyword("")}
                title="清除"
              >
                <i className="ri-close-line" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Tree */}
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={(e) => void handleDragEnd(e)}
          >
          <MgrRootDropZone onContextMenu={handleEmptyContextMenu}>
            {!hasVisibleConnections ? (
              <div className="mgr-tree-empty">
                {keyword ? (
                  <>
                    <i className="ri-search-line" aria-hidden="true" />
                    <span>未找到匹配连接</span>
                  </>
                ) : (
                  <>
                    <i className="ri-server-line" aria-hidden="true" />
                    <span>暂无连接</span>
                  </>
                )}
              </div>
            ) : (
              <MgrTreeGroup
                node={tree}
                depth={0}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                primarySelectedId={primarySelectedId}
                selectedIds={selectedIds}
                cutIds={cutIds}
                renamingId={renamingId}
                onSelect={handleMultiSelect}
                onDoubleClick={(id) => void handleQuickConnect(id)}
                onQuickConnect={(id) => void handleQuickConnect(id)}
                onContextMenu={handleConnectionContextMenu}
                onGroupContextMenu={handleGroupContextMenu}
                onGroupCtrlClick={handleGroupCtrlClick}
                onRenameCommit={(id, name) => void handleRenameCommit(id, name)}
                onRenameCancel={handleRenameCancel}
              />
            )}
          </MgrRootDropZone>
          <DragOverlay>
            {draggingConnection ? (
              <div className="mgr-drag-overlay">
                <i className="ri-server-line" aria-hidden="true" />
                <span>{draggingConnection.name}</span>
                {selectedIds.has(draggingConnection.id) && selectedIds.size > 1 && (
                  <span className="mgr-drag-badge">+{selectedIds.size - 1}</span>
                )}
              </div>
            ) : null}
          </DragOverlay>
          </DndContext>

          {/* Context menu */}
          {contextMenu && (
            <MgrContextMenu
              state={contextMenu}
              clipboard={clipboard}
              connections={connections}
              selectedIds={selectedIds}
              sortMode={sortMode}
              onClose={() => setContextMenu(null)}
              onConnect={(id) => void handleQuickConnect(id)}
              onEdit={(id) => handleSelectSingle(id)}
              onRename={handleCtxRename}
              onCopy={handleCtxCopy}
              onCut={handleCtxCut}
              onPaste={(path) => void handleCtxPaste(path)}
              onDelete={handleDelete}
              onCopyAddress={handleCtxCopyAddress}
              onNewConnection={(groupPath) => handleNew(groupPath)}
              onNewFolder={(path) => void handleCtxNewFolder(path)}
              onSort={setSortMode}
              onImportNextShell={handleImportNextShell}
              onImportFinalShell={handleImportFinalShell}
              onExportSelected={() => void handleExportSelected()}
              onExportAll={() => void handleExportAll()}
            />
          )}

          {/* Clipboard bar */}
          {clipboard && (
            <div className="mgr-clipboard-bar">
              <span>
                {clipboard.mode === "copy" ? "已复制" : "已剪切"} {clipboard.connectionIds.length} 个连接
              </span>
              <button
                type="button"
                className="mgr-clipboard-clear"
                onClick={() => setClipboard(null)}
                title="清除"
              >
                <i className="ri-close-line" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="mgr-sidebar-footer">
            <span className="mgr-count">
              {connections.length} 个连接
              {selectedExportCount > 0 ? ` · 已选 ${selectedExportCount}` : ""}
            </span>
            <div className="mgr-sidebar-footer-actions">
              <Tooltip title="导入 NextShell 文件">
                <button type="button" className="mgr-action-btn" onClick={handleImportNextShell} disabled={importingPreview}>
                  <i className={importingPreview ? "ri-loader-4-line ri-spin" : "ri-upload-2-line"} />
                </button>
              </Tooltip>
              <Tooltip title="导入 FinalShell 文件">
                <button
                  type="button"
                  className="mgr-action-btn"
                  onClick={handleImportFinalShell}
                  disabled={importingPreview}
                >
                  <i className="ri-file-upload-line" />
                </button>
              </Tooltip>
              <Tooltip title="导出选中连接">
                <button
                  type="button"
                  className="mgr-action-btn"
                  onClick={handleExportSelected}
                  disabled={selectedExportCount === 0}
                >
                  <i className="ri-download-cloud-2-line" />
                </button>
              </Tooltip>
              <Tooltip title="导出所有连接">
                <button type="button" className="mgr-action-btn" onClick={handleExportAll}
                  disabled={connections.length === 0}>
                  <i className="ri-download-2-line" />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* ── Right panel ─────────────────────── */}
        {mode === "idle" ? (
          <div className="mgr-empty-state">
            <i className="ri-server-line mgr-empty-icon" aria-hidden="true" />
            <div className="mgr-empty-title">选择或新建连接</div>
            <div className="mgr-empty-hint">从左侧列表选择一个连接进行编辑，或点击下方按钮新建连接</div>
            <button type="button" className="mgr-empty-new-btn" onClick={() => handleNew()}>
              <i className="ri-add-line" aria-hidden="true" />
              新建连接
            </button>
          </div>
        ) : (
          <div className="flex flex-col overflow-hidden">

            {/* Form header */}
            <div className="mgr-form-header">
              <div>
                <div className="mgr-form-title">
                  {mode === "new" ? "新建连接" : (selectedConnection?.name ?? "编辑连接")}
                </div>
                {mode === "edit" && selectedConnection ? (
                  <>
                    <div className="mgr-form-subtitle">
                      {selectedConnection.username.trim()
                        ? `${selectedConnection.username}@${selectedConnection.host}:${selectedConnection.port}`
                        : `${selectedConnection.host}:${selectedConnection.port}`}
                    </div>
                    <div className="mgr-form-meta">
                      <span
                        className="mgr-form-meta-item"
                        title={`修改时间：${formatDateTime(selectedConnection.updatedAt)}`}
                      >
                        <i className="ri-edit-2-line" aria-hidden="true" />
                        {formatRelativeTime(selectedConnection.updatedAt)}
                      </span>
                      <span className="mgr-form-meta-sep">·</span>
                      <span
                        className="mgr-form-meta-item"
                        title={selectedConnection.lastConnectedAt
                          ? `上次连接：${formatDateTime(selectedConnection.lastConnectedAt)}`
                          : "从未连接"}
                      >
                        <i className="ri-plug-line" aria-hidden="true" />
                        {selectedConnection.lastConnectedAt
                          ? formatRelativeTime(selectedConnection.lastConnectedAt)
                          : "从未连接"}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="mgr-form-subtitle">填写以下信息后点击保存</div>
                )}
              </div>
              <div className="mgr-form-header-right">
                <span className="mgr-ssh-badge">SSH</span>
                <button
                  type="button"
                  className="mgr-connect-btn"
                  onClick={() => void handleSaveAndConnect()}
                  disabled={saving || connectingFromForm}
                  title="保存并连接"
                >
                  {connectingFromForm ? (
                    <i className="ri-loader-4-line mgr-form-header-icon-spin" aria-hidden="true" />
                  ) : (
                    <i className="ri-terminal-box-line" aria-hidden="true" />
                  )}
                  连接
                </button>
                {mode === "edit" ? (
                  <Tooltip title="删除连接">
                    <button
                      type="button"
                      className="mgr-form-header-icon-btn mgr-form-header-icon-btn--danger"
                      onClick={handleDelete}
                      aria-label="删除连接"
                    >
                      <i className="ri-delete-bin-line" aria-hidden="true" />
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip title="取消">
                    <button
                      type="button"
                      className="mgr-form-header-icon-btn"
                      onClick={() => setMode("idle")}
                      aria-label="取消"
                    >
                      <i className="ri-arrow-left-line" aria-hidden="true" />
                    </button>
                  </Tooltip>
                )}
                <Tooltip title="重置">
                  <button
                    type="button"
                    className="mgr-form-header-icon-btn"
                    onClick={handleReset}
                    aria-label="重置"
                  >
                    <i className="ri-refresh-line" aria-hidden="true" />
                  </button>
                </Tooltip>
                <Tooltip title="保存连接">
                  <button
                    type="button"
                    className="mgr-form-header-icon-btn mgr-form-header-icon-btn--primary"
                    onClick={() => form.submit()}
                    disabled={saving || connectingFromForm}
                    aria-label="保存连接"
                  >
                    {saving ? (
                      <i className="ri-loader-4-line mgr-form-header-icon-spin" aria-hidden="true" />
                    ) : (
                      <i className="ri-save-line" aria-hidden="true" />
                    )}
                  </button>
                </Tooltip>
                <Tooltip title="收起表单">
                  <button
                    type="button"
                    className="mgr-form-close-btn"
                    onClick={handleCloseForm}
                    aria-label="收起表单"
                  >
                    <i className="ri-close-line" aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            </div>

            <Form
              form={form}
              layout="vertical"
              requiredMark={false}
              className="mgr-form"
              initialValues={DEFAULT_VALUES}
              onFinish={async (values) => {
                await saveConnection(values);
              }}
              onFinishFailed={({ errorFields }) => {
                const firstField = String(errorFields[0]?.name?.[0] ?? "");
                const errTab = FIELD_TAB_MAP[firstField];
                if (errTab) setFormTab(errTab);
              }}
            >
              {/* ── Form tab bar ──── */}
              <div className="mgr-form-tab-bar">
                <button
                  type="button"
                  title="基本信息"
                  className={`mgr-form-tab${formTab === "basic" ? " mgr-form-tab--active" : ""}`}
                  onClick={() => setFormTab("basic")}
                >
                  <i className="ri-server-line" aria-hidden="true" />
                  基本
                </button>
                <button
                  type="button"
                  title="属性信息"
                  className={`mgr-form-tab${formTab === "property" ? " mgr-form-tab--active" : ""}`}
                  onClick={() => setFormTab("property")}
                >
                  <i className="ri-price-tag-3-line" aria-hidden="true" />
                  属性
                </button>
                <button
                  type="button"
                  title="网络代理"
                  className={`mgr-form-tab${formTab === "network" ? " mgr-form-tab--active" : ""}`}
                  onClick={() => setFormTab("network")}
                >
                  <i className="ri-shield-line" aria-hidden="true" />
                  网络
                </button>
                <button
                  type="button"
                  title="高级设置"
                  className={`mgr-form-tab${formTab === "advanced" ? " mgr-form-tab--active" : ""}`}
                  onClick={() => setFormTab("advanced")}
                >
                  <i className="ri-settings-3-line" aria-hidden="true" />
                  高级
                </button>
              </div>

              <div className="mgr-form-tab-body">
                {/* ── Tab: 基本 ──── */}
                <div style={{ display: formTab === "basic" ? "" : "none" }}>
                    <Form.Item label="名称" name="name">
                      <Input placeholder="我的服务器（可选，留空将使用 host:port）" />
                    </Form.Item>

                    <div className="flex gap-3 items-start">
                      <Form.Item
                        label="Host / IP"
                        name="host"
                        rules={[{ required: true, message: "请输入主机地址" }]}
                        style={{ flex: 1 }}
                      >
                        <Input placeholder="192.168.1.1 或 example.com" style={{ fontFamily: "var(--mono)" }} />
                      </Form.Item>
                      <Form.Item
                        label="端口"
                        name="port"
                        rules={[{ required: true, message: "请输入端口" }]}
                        className="w-[90px] shrink-0"
                      >
                        <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} />
                      </Form.Item>
                    </div>

                    <div className="flex gap-3 items-start">
                      <Form.Item
                        label="用户名"
                        name="username"
                        className="flex-1"
                      >
                        <Input placeholder="root（可选，首次连接时输入）" />
                      </Form.Item>
                      <Form.Item
                        label="认证方式"
                        name="authType"
                        rules={[{ required: true }]}
                        className="w-[150px] shrink-0"
                      >
                        <Select
                          options={[
                            { label: "密码", value: "password" },
                            { label: "交互式登录", value: "interactive" },
                            { label: "私钥文件", value: "privateKey" },
                            { label: "SSH Agent", value: "agent" }
                          ]}
                        />
                      </Form.Item>
                    </div>

                    {authType === "privateKey" ? (
                      <Form.Item
                        label="SSH 密钥"
                        name="sshKeyId"
                        rules={[{ required: true, message: "请选择一个 SSH 密钥" }]}
                      >
                        <Select
                          placeholder="选择密钥..."
                          allowClear
                          options={sshKeys.map((k) => ({ label: k.name, value: k.id }))}
                          notFoundContent={
                            <div style={{ textAlign: "center", padding: "8px 0", color: "var(--text-muted)" }}>
                              暂无密钥，请先在「密钥管理」中添加
                            </div>
                          }
                        />
                      </Form.Item>
                    ) : null}

                    {authType === "password" || authType === "interactive" ? (
                      <>
                        <Form.Item
                          label="密码"
                          name="password"
                          preserve={false}
                        >
                          <Input.Password placeholder="输入密码（留空则不更新）" />
                        </Form.Item>
                        {mode === "edit" && (
                          selectedConnection?.authType === "password" ||
                          selectedConnection?.authType === "interactive"
                        ) ? (
                          <Form.Item label="已保存的登录密码" preserve={false}>
                            <div style={{ display: "grid", gap: 8 }}>
                              <button
                                type="button"
                                className="mgr-action-btn"
                                onClick={() => void handleRevealConnectionPassword()}
                                disabled={revealingLoginPassword}
                                style={{ justifySelf: "start" }}
                              >
                                <i
                                  className={revealingLoginPassword ? "ri-loader-4-line" : "ri-eye-line"}
                                  aria-hidden="true"
                                />
                                {revealingLoginPassword ? "验证中..." : "输入主密码查看"}
                              </button>
                              {revealedLoginPassword ? (
                                <Input.Password
                                  value={revealedLoginPassword}
                                  readOnly
                                  visibilityToggle
                                />
                              ) : (
                                <div style={{ fontSize: 12, color: "var(--t3)" }}>
                                  仅在输入主密码后显示，30 秒自动隐藏。
                                </div>
                              )}
                            </div>
                          </Form.Item>
                        ) : null}
                      </>
                    ) : null}

                    <div className="mgr-section-label mgr-section-gap">安全</div>

                    <div className="flex gap-3 items-start">
                      <Form.Item
                        label="主机指纹（SHA256:... / md5:aa:bb... / hex）"
                        name="hostFingerprint"
                        className="flex-1"
                      >
                        <Input placeholder="SHA256:xxxxxxxxxxxxxxxxxxxx" className="mgr-mono-input" />
                      </Form.Item>
                      <Form.Item
                        label="严格主机校验"
                        name="strictHostKeyChecking"
                        valuePropName="checked"
                        className="shrink-0 !mb-0"
                      >
                        <Switch size="small" />
                      </Form.Item>
                    </div>
                </div>

                {/* ── Tab: 属性 ──── */}
                <div style={{ display: formTab === "property" ? "" : "none" }}>
                    <Form.Item label="分组路径" required>
                      <div className="flex gap-2 items-start">
                        <Form.Item name="groupZone" noStyle>
                          <Select
                            style={{ width: 120, flexShrink: 0 }}
                            options={ZONE_ORDER.map((z) => ({
                              label: ZONE_DISPLAY_NAMES[z],
                              value: z
                            }))}
                          />
                        </Form.Item>
                        <Form.Item name="groupSubPath" noStyle>
                          <Input
                            placeholder="/production"
                            prefix={<i className="ri-folder-3-line" style={{ color: "var(--t3)", fontSize: 13 }} />}
                            style={{ fontFamily: "var(--mono)" }}
                          />
                        </Form.Item>
                      </div>
                    </Form.Item>

                    <div className="flex gap-3 items-start">
                      <Form.Item label="标签" name="tags" className="flex-1">
                        <Select
                          mode="tags"
                          tokenSeparators={[","]}
                          placeholder="web, linux, prod"
                        />
                      </Form.Item>
                      <Form.Item
                        label="收藏"
                        name="favorite"
                        valuePropName="checked"
                        className="shrink-0 !mb-0"
                      >
                        <Switch size="small" />
                      </Form.Item>
                    </div>

                    <Form.Item label="备注" name="notes" className="!mb-0">
                      <Input.TextArea rows={2} placeholder="可选备注信息..." className="mgr-textarea" />
                    </Form.Item>
                </div>

                {/* ── Tab: 网络 ──── */}
                <div style={{ display: formTab === "network" ? "" : "none" }}>
                    <Form.Item
                      label="代理"
                      name="proxyId"
                    >
                      <Select
                        placeholder="直连（不使用代理）"
                        allowClear
                        options={proxies.map((p) => ({
                          label: `${p.name} (${p.proxyType.toUpperCase()} ${p.host}:${p.port})`,
                          value: p.id
                        }))}
                        notFoundContent={
                          <div style={{ textAlign: "center", padding: "8px 0", color: "var(--text-muted)" }}>
                            暂无代理，请先在「代理管理」中添加
                          </div>
                        }
                      />
                    </Form.Item>

                    <div className="mgr-section-label mgr-section-gap">连接保活</div>

                    <Form.Item label="Keepalive（发送空包）" name="keepAliveEnabled">
                      <Select
                        placeholder="跟随全局设置"
                        allowClear
                        options={[
                          { label: "启用", value: true },
                          { label: "禁用", value: false }
                        ]}
                      />
                    </Form.Item>

                    <Form.Item label="保活间隔（秒）" name="keepAliveIntervalSec">
                      <InputNumber
                        min={5}
                        max={600}
                        precision={0}
                        style={{ width: "100%" }}
                        placeholder="留空跟随全局"
                        disabled={keepAliveSetting === false}
                      />
                    </Form.Item>

                    <div className="mgr-form-subtitle">
                      留空表示跟随全局设置，修改后需重连会话生效。
                    </div>
                </div>

                {/* ── Tab: 高级 ──── */}
                <div style={{ display: formTab === "advanced" ? "" : "none" }}>
                    <div className="flex gap-3 items-start">
                      <Form.Item
                        label="监控会话"
                        name="monitorSession"
                        valuePropName="checked"
                        className="shrink-0 !mb-0"
                      >
                        <Switch size="small" />
                      </Form.Item>
                      <div className="mgr-monitor-hint">
                        启用后支持进程管理器和网络监控
                      </div>
                    </div>

                    <Form.Item
                      label="字符编码"
                      name="terminalEncoding"
                    >
                      <Select
                        options={[
                          { label: "UTF-8", value: "utf-8" },
                          { label: "GB18030", value: "gb18030" },
                          { label: "GBK", value: "gbk" },
                          { label: "Big5", value: "big5" }
                        ]}
                      />
                    </Form.Item>

                    <div className="mgr-section-label">按键序列</div>

                    <div className="flex gap-3 items-start">
                      <Form.Item
                        label="Backspace 退格键"
                        name="backspaceMode"
                        className="flex-1"
                      >
                        <Select
                          options={[
                            { label: "ASCII - Backspace", value: "ascii-backspace" },
                            { label: "ASCII - Delete", value: "ascii-delete" }
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        label="Delete 删除键"
                        name="deleteMode"
                        className="flex-1"
                      >
                        <Select
                          options={[
                            { label: "VT220 - Delete", value: "vt220-delete" },
                            { label: "ASCII - Delete", value: "ascii-delete" },
                            { label: "ASCII - Backspace", value: "ascii-backspace" }
                          ]}
                        />
                      </Form.Item>
                    </div>

                    <div className="mgr-form-subtitle">终端高级配置保存后需重连会话生效。</div>
                </div>
              </div>
            </Form>
          </div>
        )}
      </div>
      )}

      {/* ── SSH Keys tab ─────────────────────── */}
      {activeTab === "keys" && (
        <SshKeyManagerPanel sshKeys={sshKeys} onReload={onReloadSshKeys} />
      )}

      {/* ── Proxies tab ──────────────────────── */}
      {activeTab === "proxies" && (
        <ProxyManagerPanel proxies={proxies} onReload={onReloadProxies} />
      )}
    </Modal>

    <ConnectionImportModal
      open={importModalOpen}
      entries={currentImportBatch?.entries ?? []}
      existingConnections={connections}
      sourceName={currentImportBatch?.fileName}
      sourceProgress={importPreviewQueue.length > 1 ? `${importQueueIndex + 1}/${importPreviewQueue.length}` : undefined}
      onClose={resetImportFlow}
      onImported={handleImportBatchImported}
    />
    </>
  );
};
