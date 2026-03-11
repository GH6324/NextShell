package model

import "encoding/json"

// ---------- Common ----------

type ErrorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Code    int    `json:"-"`
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
	Connections []json.RawMessage `json:"connections"`
	SSHKeys     []json.RawMessage `json:"sshKeys"`
	Proxies     []json.RawMessage `json:"proxies"`
	Deleted     DeletedIDs        `json:"deleted"`
}

type DeletedIDs struct {
	Connections []string `json:"connections"`
	SSHKeys     []string `json:"sshKeys"`
	Proxies     []string `json:"proxies"`
}

// ---------- Upsert ----------

type UpsertConnectionRequest struct {
	BaseVersion int64           `json:"baseVersion"`
	Connection  json.RawMessage `json:"connection"`
}

type UpsertSSHKeyRequest struct {
	BaseVersion int64           `json:"baseVersion"`
	SSHKey      json.RawMessage `json:"sshKey"`
}

type UpsertProxyRequest struct {
	BaseVersion int64           `json:"baseVersion"`
	Proxy       json.RawMessage `json:"proxy"`
}

type UpsertResponse struct {
	OK        bool   `json:"ok"`
	Version   int64  `json:"version"`
	UpdatedAt string `json:"updatedAt"`
}

// ---------- Delete ----------

type DeleteRequest struct {
	BaseVersion int64  `json:"baseVersion"`
	ID          string `json:"id"`
}

type DeleteResponse struct {
	OK        bool   `json:"ok"`
	Version   int64  `json:"version"`
	DeletedAt string `json:"deletedAt"`
}
