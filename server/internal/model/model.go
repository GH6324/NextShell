package model

import "encoding/json"

// ---------- Common ----------

type ErrorResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Code  int    `json:"-"`
}

// ---------- Workspace Status ----------

type WorkspaceStatusRequest struct{}

type WorkspaceStatusResponse struct {
	OK         bool   `json:"ok"`
	Workspace  string `json:"workspace"`
	Version    int64  `json:"version"`
	ServerTime string `json:"serverTime"`
}

// ---------- Pull ----------

type PullRequest struct {
	KnownVersion int64 `json:"knownVersion"`
}

type PullResponse struct {
	OK         bool      `json:"ok"`
	Workspace  string    `json:"workspace"`
	Version    int64     `json:"version"`
	Unchanged  bool      `json:"unchanged"`
	ServerTime string    `json:"serverTime"`
	Snapshot   *Snapshot `json:"snapshot,omitempty"`
}

type Snapshot struct {
	Connections []ResourceSnapshot `json:"connections"`
	SSHKeys     []ResourceSnapshot `json:"sshKeys"`
	Proxies     []ResourceSnapshot `json:"proxies"`
	Deleted     DeletedResources   `json:"deleted"`
}

type ResourceSnapshot struct {
	Payload   json.RawMessage `json:"payload"`
	Revision  int64           `json:"revision"`
	UpdatedAt string          `json:"updatedAt"`
}

type DeletedResource struct {
	ID        string `json:"id"`
	Revision  int64  `json:"revision"`
	DeletedAt string `json:"deletedAt"`
}

type DeletedResources struct {
	Connections []DeletedResource `json:"connections"`
	SSHKeys     []DeletedResource `json:"sshKeys"`
	Proxies     []DeletedResource `json:"proxies"`
}

// ---------- Upsert ----------

type UpsertConnectionRequest struct {
	BaseRevision *int64          `json:"baseRevision"`
	Force        bool            `json:"force"`
	Connection   json.RawMessage `json:"connection"`
}

type UpsertSSHKeyRequest struct {
	BaseRevision *int64          `json:"baseRevision"`
	Force        bool            `json:"force"`
	SSHKey       json.RawMessage `json:"sshKey"`
}

type UpsertProxyRequest struct {
	BaseRevision *int64          `json:"baseRevision"`
	Force        bool            `json:"force"`
	Proxy        json.RawMessage `json:"proxy"`
}

type UpsertResponse struct {
	OK               bool   `json:"ok"`
	WorkspaceVersion int64  `json:"workspaceVersion"`
	ResourceRevision int64  `json:"resourceRevision"`
	UpdatedAt        string `json:"updatedAt"`
}

// ---------- Delete ----------

type DeleteRequest struct {
	BaseRevision *int64 `json:"baseRevision"`
	Force        bool   `json:"force"`
	ID           string `json:"id"`
}

type DeleteResponse struct {
	OK               bool   `json:"ok"`
	WorkspaceVersion int64  `json:"workspaceVersion"`
	ResourceRevision int64  `json:"resourceRevision"`
	DeletedAt        string `json:"deletedAt"`
}

type ConflictResponse struct {
	OK       bool                 `json:"ok"`
	Error    string               `json:"error"`
	Conflict ResourceConflictInfo `json:"conflict"`
}

type ResourceConflictInfo struct {
	ResourceType    string          `json:"resourceType"`
	ResourceID      string          `json:"resourceId"`
	ServerRevision  int64           `json:"serverRevision"`
	ServerUpdatedAt string          `json:"serverUpdatedAt"`
	ServerDeleted   bool            `json:"serverDeleted"`
	ServerPayload   json.RawMessage `json:"serverPayload,omitempty"`
}
