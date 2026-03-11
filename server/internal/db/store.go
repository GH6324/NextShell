package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// ---------- Workspace ----------

// EnsureWorkspace creates the workspace if it doesn't exist, or verifies the password if it does.
// Returns the workspace name or an error.
func (s *Store) EnsureWorkspace(name, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("bcrypt hash: %w", err)
	}

	// Try insert; ignore if already exists.
	_, err = s.db.Exec(
		`INSERT OR IGNORE INTO workspaces (workspace_name, password_hash) VALUES (?, ?)`,
		name, string(hash),
	)
	if err != nil {
		return fmt.Errorf("insert workspace: %w", err)
	}

	// Fetch stored hash and verify.
	var storedHash string
	if err := s.db.QueryRow(
		`SELECT password_hash FROM workspaces WHERE workspace_name = ?`, name,
	).Scan(&storedHash); err != nil {
		return fmt.Errorf("fetch workspace: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password)); err != nil {
		return fmt.Errorf("invalid password")
	}
	return nil
}

func (s *Store) GetVersion(workspace string) (int64, error) {
	var v int64
	err := s.db.QueryRow(
		`SELECT version FROM workspaces WHERE workspace_name = ?`, workspace,
	).Scan(&v)
	return v, err
}

// ---------- Pull ----------

type SnapshotData struct {
	Connections        []json.RawMessage
	SSHKeys            []json.RawMessage
	Proxies            []json.RawMessage
	DeletedConnections []string
	DeletedSSHKeys     []string
	DeletedProxies     []string
}

func (s *Store) PullSnapshot(workspace string) (*SnapshotData, int64, error) {
	version, err := s.GetVersion(workspace)
	if err != nil {
		return nil, 0, err
	}

	snap := &SnapshotData{}

	snap.Connections, err = s.listPayloads("connections", workspace)
	if err != nil {
		return nil, 0, err
	}
	snap.SSHKeys, err = s.listPayloads("ssh_keys", workspace)
	if err != nil {
		return nil, 0, err
	}
	snap.Proxies, err = s.listPayloads("proxies", workspace)
	if err != nil {
		return nil, 0, err
	}

	snap.DeletedConnections, err = s.listTombstones(workspace, "connection")
	if err != nil {
		return nil, 0, err
	}
	snap.DeletedSSHKeys, err = s.listTombstones(workspace, "ssh_key")
	if err != nil {
		return nil, 0, err
	}
	snap.DeletedProxies, err = s.listTombstones(workspace, "proxy")
	if err != nil {
		return nil, 0, err
	}

	return snap, version, nil
}

func (s *Store) listPayloads(table, workspace string) ([]json.RawMessage, error) {
	rows, err := s.db.Query(
		fmt.Sprintf(`SELECT payload_json FROM %s WHERE workspace_name = ?`, table), workspace,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []json.RawMessage
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		result = append(result, json.RawMessage(p))
	}
	if result == nil {
		result = []json.RawMessage{}
	}
	return result, rows.Err()
}

func (s *Store) listTombstones(workspace, resourceType string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT resource_id FROM deleted_tombstones WHERE workspace_name = ? AND resource_type = ?`,
		workspace, resourceType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, rows.Err()
}

// ---------- Upsert ----------

func (s *Store) UpsertConnection(workspace, id string, payload json.RawMessage) (int64, string, error) {
	return s.upsertResource("connections", "connection", workspace, id, payload)
}

func (s *Store) UpsertSSHKey(workspace, id string, payload json.RawMessage) (int64, string, error) {
	return s.upsertResource("ssh_keys", "ssh_key", workspace, id, payload)
}

func (s *Store) UpsertProxy(workspace, id string, payload json.RawMessage) (int64, string, error) {
	return s.upsertResource("proxies", "proxy", workspace, id, payload)
}

func (s *Store) upsertResource(table, tombstoneType, workspace, id string, payload json.RawMessage) (int64, string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)

	// Upsert the resource.
	_, err = tx.Exec(
		fmt.Sprintf(`INSERT INTO %s (workspace_name, id, payload_json, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (workspace_name, id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`, table),
		workspace, id, string(payload), now,
	)
	if err != nil {
		return 0, "", fmt.Errorf("upsert %s: %w", table, err)
	}

	// Remove any tombstone for this resource (re-creation scenario).
	_, err = tx.Exec(
		`DELETE FROM deleted_tombstones WHERE workspace_name = ? AND resource_type = ? AND resource_id = ?`,
		workspace, tombstoneType, id,
	)
	if err != nil {
		return 0, "", fmt.Errorf("delete tombstone: %w", err)
	}

	// Increment version.
	version, err := s.incrementVersion(tx, workspace, now)
	if err != nil {
		return 0, "", err
	}

	if err := tx.Commit(); err != nil {
		return 0, "", err
	}
	return version, now, nil
}

// ---------- Delete ----------

func (s *Store) DeleteConnection(workspace, id string) (int64, string, error) {
	return s.deleteResource("connections", "connection", workspace, id)
}

func (s *Store) DeleteSSHKey(workspace, id string) (int64, string, error) {
	// Check if any connection references this SSH key.
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM connections WHERE workspace_name = ? AND json_extract(payload_json, '$.sshKeyId') = ?`,
		workspace, id,
	).Scan(&count)
	if err != nil {
		return 0, "", fmt.Errorf("check ssh key refs: %w", err)
	}
	if count > 0 {
		return 0, "", &ConflictError{Message: fmt.Sprintf("ssh key %q is still referenced by %d connection(s)", id, count)}
	}
	return s.deleteResource("ssh_keys", "ssh_key", workspace, id)
}

func (s *Store) DeleteProxy(workspace, id string) (int64, string, error) {
	// Check if any connection references this proxy.
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM connections WHERE workspace_name = ? AND json_extract(payload_json, '$.proxyId') = ?`,
		workspace, id,
	).Scan(&count)
	if err != nil {
		return 0, "", fmt.Errorf("check proxy refs: %w", err)
	}
	if count > 0 {
		return 0, "", &ConflictError{Message: fmt.Sprintf("proxy %q is still referenced by %d connection(s)", id, count)}
	}
	return s.deleteResource("proxies", "proxy", workspace, id)
}

type ConflictError struct {
	Message string
}

func (e *ConflictError) Error() string { return e.Message }

func (s *Store) deleteResource(table, tombstoneType, workspace, id string) (int64, string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)

	// Delete the resource.
	_, err = tx.Exec(
		fmt.Sprintf(`DELETE FROM %s WHERE workspace_name = ? AND id = ?`, table),
		workspace, id,
	)
	if err != nil {
		return 0, "", fmt.Errorf("delete %s: %w", table, err)
	}

	// Insert tombstone.
	_, err = tx.Exec(
		`INSERT OR REPLACE INTO deleted_tombstones (workspace_name, resource_type, resource_id, deleted_at) VALUES (?, ?, ?, ?)`,
		workspace, tombstoneType, id, now,
	)
	if err != nil {
		return 0, "", fmt.Errorf("insert tombstone: %w", err)
	}

	// Increment version.
	version, err := s.incrementVersion(tx, workspace, now)
	if err != nil {
		return 0, "", err
	}

	if err := tx.Commit(); err != nil {
		return 0, "", err
	}
	return version, now, nil
}

// ---------- Helpers ----------

func (s *Store) incrementVersion(tx *sql.Tx, workspace, now string) (int64, error) {
	_, err := tx.Exec(
		`UPDATE workspaces SET version = version + 1, updated_at = ? WHERE workspace_name = ?`,
		now, workspace,
	)
	if err != nil {
		return 0, fmt.Errorf("increment version: %w", err)
	}

	var version int64
	err = tx.QueryRow(
		`SELECT version FROM workspaces WHERE workspace_name = ?`, workspace,
	).Scan(&version)
	if err != nil {
		return 0, fmt.Errorf("get version: %w", err)
	}
	return version, nil
}
