package db

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidPassword           = errors.New("invalid password")
	ErrWorkspacePasswordTooShort = errors.New("workspace password must be at least 8 characters")
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
	// Check if workspace already exists.
	var storedHash string
	err := s.db.QueryRow(
		`SELECT password_hash FROM workspaces WHERE workspace_name = ?`, name,
	).Scan(&storedHash)

	if err == sql.ErrNoRows {
		// New workspace — enforce minimum password length.
		if len(password) < 8 {
			return ErrWorkspacePasswordTooShort
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return fmt.Errorf("bcrypt hash: %w", err)
		}
		_, err = s.db.Exec(
			`INSERT INTO workspaces (workspace_name, password_hash) VALUES (?, ?)`,
			name, string(hash),
		)
		if err != nil {
			return fmt.Errorf("insert workspace: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("fetch workspace: %w", err)
	}

	// Existing workspace — verify password.
	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password)); err != nil {
		return ErrInvalidPassword
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
	Connections        []ResourceSnapshot
	SSHKeys            []ResourceSnapshot
	Proxies            []ResourceSnapshot
	DeletedConnections []DeletedResource
	DeletedSSHKeys     []DeletedResource
	DeletedProxies     []DeletedResource
}

type ResourceSnapshot struct {
	Payload   json.RawMessage
	Revision  int64
	UpdatedAt string
}

type DeletedResource struct {
	ID        string
	Revision  int64
	DeletedAt string
}

type ResourceConflict struct {
	ResourceType    string
	ResourceID      string
	ServerRevision  int64
	ServerUpdatedAt string
	ServerDeleted   bool
	ServerPayload   json.RawMessage
}

type OptimisticConflictError struct {
	Conflict ResourceConflict
}

func (e *OptimisticConflictError) Error() string {
	return "optimistic concurrency conflict"
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

func (s *Store) listPayloads(table, workspace string) ([]ResourceSnapshot, error) {
	rows, err := s.db.Query(
		fmt.Sprintf(`SELECT payload_json, revision, updated_at FROM %s WHERE workspace_name = ? ORDER BY id`, table), workspace,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []ResourceSnapshot
	for rows.Next() {
		var item ResourceSnapshot
		var payload string
		if err := rows.Scan(&payload, &item.Revision, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.Payload = json.RawMessage(payload)
		result = append(result, item)
	}
	if result == nil {
		result = []ResourceSnapshot{}
	}
	return result, rows.Err()
}

func (s *Store) listTombstones(workspace, resourceType string) ([]DeletedResource, error) {
	rows, err := s.db.Query(
		`SELECT resource_id, revision, deleted_at FROM deleted_tombstones WHERE workspace_name = ? AND resource_type = ? ORDER BY resource_id`,
		workspace, resourceType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tombstones []DeletedResource
	for rows.Next() {
		var tombstone DeletedResource
		if err := rows.Scan(&tombstone.ID, &tombstone.Revision, &tombstone.DeletedAt); err != nil {
			return nil, err
		}
		tombstones = append(tombstones, tombstone)
	}
	if tombstones == nil {
		tombstones = []DeletedResource{}
	}
	return tombstones, rows.Err()
}

// ---------- Upsert ----------

func (s *Store) UpsertConnection(workspace, id string, payload json.RawMessage, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	return s.upsertResource("connections", "connection", "connection", workspace, id, payload, baseRevision, force)
}

func (s *Store) UpsertSSHKey(workspace, id string, payload json.RawMessage, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	return s.upsertResource("ssh_keys", "ssh_key", "sshKey", workspace, id, payload, baseRevision, force)
}

func (s *Store) UpsertProxy(workspace, id string, payload json.RawMessage, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	return s.upsertResource("proxies", "proxy", "proxy", workspace, id, payload, baseRevision, force)
}

func (s *Store) upsertResource(table, tombstoneType, resourceType, workspace, id string, payload json.RawMessage, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, "", nil, err
	}
	defer tx.Rollback()

	current, err := s.getCurrentResourceStateTx(tx, table, tombstoneType, workspace, id)
	if err != nil {
		return 0, 0, "", nil, err
	}
	if conflict := validateResourceRevision(resourceType, id, current, baseRevision, force); conflict != nil {
		return 0, 0, "", conflict, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	nextRevision := current.NextRevision()

	if current.Exists && !current.Deleted {
		_, err = tx.Exec(
			fmt.Sprintf(`UPDATE %s SET payload_json = ?, revision = ?, updated_at = ? WHERE workspace_name = ? AND id = ?`, table),
			string(payload), nextRevision, now, workspace, id,
		)
	} else {
		_, err = tx.Exec(
			fmt.Sprintf(`INSERT INTO %s (workspace_name, id, payload_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (workspace_name, id) DO UPDATE SET payload_json = excluded.payload_json, revision = excluded.revision, updated_at = excluded.updated_at`, table),
			workspace, id, string(payload), nextRevision, now,
		)
	}
	if err != nil {
		return 0, 0, "", nil, fmt.Errorf("upsert %s: %w", table, err)
	}

	_, err = tx.Exec(
		`DELETE FROM deleted_tombstones WHERE workspace_name = ? AND resource_type = ? AND resource_id = ?`,
		workspace, tombstoneType, id,
	)
	if err != nil {
		return 0, 0, "", nil, fmt.Errorf("delete tombstone: %w", err)
	}

	version, err := s.incrementVersion(tx, workspace, now)
	if err != nil {
		return 0, 0, "", nil, err
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, "", nil, err
	}
	return version, nextRevision, now, nil, nil
}

// ---------- Delete ----------

func (s *Store) DeleteConnection(workspace, id string, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	return s.deleteResource("connections", "connection", "connection", workspace, id, baseRevision, force)
}

func (s *Store) DeleteSSHKey(workspace, id string, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	// Check if any connection references this SSH key.
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM connections WHERE workspace_name = ? AND json_extract(payload_json, '$.sshKeyId') = ?`,
		workspace, id,
	).Scan(&count)
	if err != nil {
		return 0, 0, "", nil, fmt.Errorf("check ssh key refs: %w", err)
	}
	if count > 0 {
		return 0, 0, "", nil, &ConflictError{Message: fmt.Sprintf("ssh key %q is still referenced by %d connection(s)", id, count)}
	}
	return s.deleteResource("ssh_keys", "ssh_key", "sshKey", workspace, id, baseRevision, force)
}

func (s *Store) DeleteProxy(workspace, id string, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	// Check if any connection references this proxy.
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM connections WHERE workspace_name = ? AND json_extract(payload_json, '$.proxyId') = ?`,
		workspace, id,
	).Scan(&count)
	if err != nil {
		return 0, 0, "", nil, fmt.Errorf("check proxy refs: %w", err)
	}
	if count > 0 {
		return 0, 0, "", nil, &ConflictError{Message: fmt.Sprintf("proxy %q is still referenced by %d connection(s)", id, count)}
	}
	return s.deleteResource("proxies", "proxy", "proxy", workspace, id, baseRevision, force)
}

type ConflictError struct {
	Message string
}

func (e *ConflictError) Error() string { return e.Message }

func (s *Store) deleteResource(table, tombstoneType, resourceType, workspace, id string, baseRevision *int64, force bool) (int64, int64, string, *ResourceConflict, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, "", nil, err
	}
	defer tx.Rollback()

	current, err := s.getCurrentResourceStateTx(tx, table, tombstoneType, workspace, id)
	if err != nil {
		return 0, 0, "", nil, err
	}
	if conflict := validateResourceRevision(resourceType, id, current, baseRevision, force); conflict != nil {
		return 0, 0, "", conflict, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	nextRevision := current.NextRevision()

	if current.Exists && !current.Deleted {
		_, err = tx.Exec(
			fmt.Sprintf(`DELETE FROM %s WHERE workspace_name = ? AND id = ?`, table),
			workspace, id,
		)
		if err != nil {
			return 0, 0, "", nil, fmt.Errorf("delete %s: %w", table, err)
		}
	}

	_, err = tx.Exec(
		`INSERT OR REPLACE INTO deleted_tombstones (workspace_name, resource_type, resource_id, revision, deleted_at) VALUES (?, ?, ?, ?, ?)`,
		workspace, tombstoneType, id, nextRevision, now,
	)
	if err != nil {
		return 0, 0, "", nil, fmt.Errorf("insert tombstone: %w", err)
	}

	version, err := s.incrementVersion(tx, workspace, now)
	if err != nil {
		return 0, 0, "", nil, err
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, "", nil, err
	}
	return version, nextRevision, now, nil, nil
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

type resourceState struct {
	Exists    bool
	Deleted   bool
	Revision  int64
	UpdatedAt string
	Payload   json.RawMessage
}

func (s *Store) getCurrentResourceStateTx(tx *sql.Tx, table, tombstoneType, workspace, id string) (resourceState, error) {
	var state resourceState
	var payload string
	err := tx.QueryRow(
		fmt.Sprintf(`SELECT payload_json, revision, updated_at FROM %s WHERE workspace_name = ? AND id = ?`, table),
		workspace, id,
	).Scan(&payload, &state.Revision, &state.UpdatedAt)
	switch {
	case err == nil:
		state.Exists = true
		state.Payload = json.RawMessage(payload)
		return state, nil
	case err != sql.ErrNoRows:
		return resourceState{}, fmt.Errorf("get %s state: %w", table, err)
	}

	err = tx.QueryRow(
		`SELECT revision, deleted_at FROM deleted_tombstones WHERE workspace_name = ? AND resource_type = ? AND resource_id = ?`,
		workspace, tombstoneType, id,
	).Scan(&state.Revision, &state.UpdatedAt)
	switch {
	case err == nil:
		state.Exists = true
		state.Deleted = true
		return state, nil
	case err == sql.ErrNoRows:
		return resourceState{}, nil
	default:
		return resourceState{}, fmt.Errorf("get tombstone state: %w", err)
	}
}

func (s resourceState) NextRevision() int64 {
	if !s.Exists {
		return 1
	}
	return s.Revision + 1
}

func validateResourceRevision(resourceType, resourceID string, current resourceState, baseRevision *int64, force bool) *ResourceConflict {
	if force && baseRevision != nil {
		return nil
	}
	if revisionsMatchCurrent(current, baseRevision) {
		return nil
	}
	return buildConflict(resourceType, resourceID, current)
}

func revisionsMatchCurrent(current resourceState, baseRevision *int64) bool {
	if !current.Exists {
		return baseRevision == nil
	}
	if baseRevision == nil {
		return false
	}
	return *baseRevision == current.Revision
}

func buildConflict(resourceType, resourceID string, current resourceState) *ResourceConflict {
	conflict := &ResourceConflict{
		ResourceType:    resourceType,
		ResourceID:      resourceID,
		ServerDeleted:   true,
		ServerRevision:  0,
		ServerUpdatedAt: "",
	}
	if !current.Exists {
		return conflict
	}
	conflict.ServerRevision = current.Revision
	conflict.ServerUpdatedAt = current.UpdatedAt
	conflict.ServerDeleted = current.Deleted
	if !current.Deleted && len(current.Payload) > 0 {
		conflict.ServerPayload = append(json.RawMessage(nil), current.Payload...)
	}
	return conflict
}
