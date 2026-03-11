package db

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

const strongWorkspacePassword = "secret-123"

func int64Ptr(value int64) *int64 {
	return &value
}

func TestStoreRejectsStaleConnectionUpsert(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	store := NewStore(database)
	if err := store.EnsureWorkspace("alice", strongWorkspacePassword); err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}

	firstPayload := json.RawMessage(`{"id":"conn-1","name":"prod-a"}`)
	secondPayload := json.RawMessage(`{"id":"conn-1","name":"prod-b"}`)

	_, firstResourceRevision, _, conflict, err := store.UpsertConnection("alice", "conn-1", firstPayload, nil, false)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if conflict != nil {
		t.Fatalf("first upsert should not conflict")
	}

	_, _, _, conflict, err = store.UpsertConnection("alice", "conn-1", secondPayload, int64Ptr(firstResourceRevision-1), false)
	if err != nil {
		t.Fatalf("stale upsert should return conflict, not hard error: %v", err)
	}
	if conflict == nil {
		t.Fatalf("stale upsert should return conflict details")
	}
	if conflict.ServerRevision != firstResourceRevision {
		t.Fatalf("expected server revision %d, got %d", firstResourceRevision, conflict.ServerRevision)
	}
}

func TestStoreForceUpsertOverridesStaleRevision(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	store := NewStore(database)
	if err := store.EnsureWorkspace("alice", strongWorkspacePassword); err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}

	firstPayload := json.RawMessage(`{"id":"conn-1","name":"prod-a"}`)
	secondPayload := json.RawMessage(`{"id":"conn-1","name":"prod-b"}`)

	_, firstResourceRevision, _, conflict, err := store.UpsertConnection("alice", "conn-1", firstPayload, nil, false)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if conflict != nil {
		t.Fatalf("first upsert should not conflict")
	}

	_, secondResourceRevision, _, conflict, err := store.UpsertConnection("alice", "conn-1", secondPayload, int64Ptr(firstResourceRevision-1), true)
	if err != nil {
		t.Fatalf("force upsert: %v", err)
	}
	if conflict != nil {
		t.Fatalf("force upsert should not conflict")
	}
	if secondResourceRevision != firstResourceRevision+1 {
		t.Fatalf("expected resource revision %d after force upsert, got %d", firstResourceRevision+1, secondResourceRevision)
	}
}

func TestStoreRejectsShortWorkspacePassword(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	store := NewStore(database)
	if err := store.EnsureWorkspace("alice", "short"); err == nil {
		t.Fatalf("expected short workspace password to be rejected")
	}
}

func TestPullSnapshotIncludesResourceAndTombstoneRevisions(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer database.Close()

	store := NewStore(database)
	if err := store.EnsureWorkspace("alice", strongWorkspacePassword); err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}

	proxyPayload := json.RawMessage(`{"id":"proxy-1","name":"hk-proxy"}`)
	workspaceVersion, proxyRevision, _, conflict, err := store.UpsertProxy("alice", "proxy-1", proxyPayload, nil, false)
	if err != nil {
		t.Fatalf("upsert proxy: %v", err)
	}
	if conflict != nil {
		t.Fatalf("upsert proxy should not conflict")
	}
	if workspaceVersion != 1 || proxyRevision != 1 {
		t.Fatalf("expected first write to set workspace/resource revision to 1, got workspace=%d resource=%d", workspaceVersion, proxyRevision)
	}

	connectionPayload := json.RawMessage(`{"id":"conn-1","name":"prod-a"}`)
	_, connectionRevision, _, conflict, err := store.UpsertConnection("alice", "conn-1", connectionPayload, nil, false)
	if err != nil {
		t.Fatalf("upsert connection: %v", err)
	}
	if conflict != nil {
		t.Fatalf("upsert connection should not conflict")
	}

	workspaceVersion, tombstoneRevision, _, conflict, err := store.DeleteConnection("alice", "conn-1", int64Ptr(connectionRevision), false)
	if err != nil {
		t.Fatalf("delete connection: %v", err)
	}
	if conflict != nil {
		t.Fatalf("delete connection should not conflict")
	}
	if workspaceVersion != 3 {
		t.Fatalf("expected workspace version 3, got %d", workspaceVersion)
	}
	if tombstoneRevision != connectionRevision+1 {
		t.Fatalf("expected tombstone revision %d, got %d", connectionRevision+1, tombstoneRevision)
	}

	snapshot, version, err := store.PullSnapshot("alice")
	if err != nil {
		t.Fatalf("pull snapshot: %v", err)
	}
	if version != 3 {
		t.Fatalf("expected snapshot version 3, got %d", version)
	}
	if len(snapshot.Proxies) != 1 {
		t.Fatalf("expected 1 proxy, got %d", len(snapshot.Proxies))
	}
	if snapshot.Proxies[0].Revision != proxyRevision {
		t.Fatalf("expected proxy revision %d, got %d", proxyRevision, snapshot.Proxies[0].Revision)
	}
	if len(snapshot.DeletedConnections) != 1 {
		t.Fatalf("expected 1 deleted connection, got %d", len(snapshot.DeletedConnections))
	}
	if snapshot.DeletedConnections[0].ID != "conn-1" {
		t.Fatalf("expected deleted connection conn-1, got %s", snapshot.DeletedConnections[0].ID)
	}
	if snapshot.DeletedConnections[0].Revision != tombstoneRevision {
		t.Fatalf("expected deleted connection revision %d, got %d", tombstoneRevision, snapshot.DeletedConnections[0].Revision)
	}
}
