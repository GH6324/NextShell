package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/hynor/nshellserver/internal/db"
	"github.com/hynor/nshellserver/internal/model"
)

func TestUpsertConnectionReturnsStructuredConflict(t *testing.T) {
	h := newTestHandler(t)

	firstRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sync/connections/upsert", bytes.NewBufferString(`{"baseRevision":null,"force":false,"connection":{"id":"conn-1","name":"prod-a"}}`))
	firstRecorder := httptest.NewRecorder()
	h.UpsertConnection(firstRecorder, withWorkspace(firstRequest, "alice"))
	if firstRecorder.Code != http.StatusOK {
		t.Fatalf("expected first upsert to succeed, got status %d", firstRecorder.Code)
	}

	staleRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sync/connections/upsert", bytes.NewBufferString(`{"baseRevision":0,"force":false,"connection":{"id":"conn-1","name":"prod-b"}}`))
	staleRecorder := httptest.NewRecorder()
	h.UpsertConnection(staleRecorder, withWorkspace(staleRequest, "alice"))
	if staleRecorder.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %d", staleRecorder.Code)
	}

	var response model.ConflictResponse
	if err := json.Unmarshal(staleRecorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode conflict response: %v", err)
	}
	if response.Error != "conflict" {
		t.Fatalf("expected conflict error, got %q", response.Error)
	}
	if response.Conflict.ResourceType != "connection" {
		t.Fatalf("expected connection conflict type, got %q", response.Conflict.ResourceType)
	}
	if response.Conflict.ResourceID != "conn-1" {
		t.Fatalf("expected conn-1 conflict id, got %q", response.Conflict.ResourceID)
	}
	if response.Conflict.ServerRevision != 1 {
		t.Fatalf("expected server revision 1, got %d", response.Conflict.ServerRevision)
	}
	if response.Conflict.ServerDeleted {
		t.Fatalf("expected live server payload, got deleted conflict")
	}
	if len(response.Conflict.ServerPayload) == 0 {
		t.Fatalf("expected server payload in conflict response")
	}
}

func TestPullReturnsRevisionMetadata(t *testing.T) {
	h := newTestHandler(t)

	upsertRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sync/proxies/upsert", bytes.NewBufferString(`{"baseRevision":null,"force":false,"proxy":{"id":"proxy-1","name":"hk-proxy"}}`))
	upsertRecorder := httptest.NewRecorder()
	h.UpsertProxy(upsertRecorder, withWorkspace(upsertRequest, "alice"))
	if upsertRecorder.Code != http.StatusOK {
		t.Fatalf("expected proxy upsert to succeed, got %d", upsertRecorder.Code)
	}

	pullRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sync/pull", bytes.NewBufferString(`{"knownVersion":0}`))
	pullRecorder := httptest.NewRecorder()
	h.Pull(pullRecorder, withWorkspace(pullRequest, "alice"))
	if pullRecorder.Code != http.StatusOK {
		t.Fatalf("expected pull to succeed, got %d", pullRecorder.Code)
	}

	var response model.PullResponse
	if err := json.Unmarshal(pullRecorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode pull response: %v", err)
	}
	if response.Unchanged {
		t.Fatalf("expected changed snapshot")
	}
	if response.Snapshot == nil {
		t.Fatalf("expected snapshot payload")
	}
	if len(response.Snapshot.Proxies) != 1 {
		t.Fatalf("expected 1 proxy snapshot, got %d", len(response.Snapshot.Proxies))
	}
	if response.Snapshot.Proxies[0].Revision != 1 {
		t.Fatalf("expected proxy revision 1, got %d", response.Snapshot.Proxies[0].Revision)
	}
	if response.Snapshot.Proxies[0].UpdatedAt == "" {
		t.Fatalf("expected proxy updatedAt metadata")
	}
}

func newTestHandler(t *testing.T) *Handler {
	t.Helper()

	database, err := db.Open(filepath.Join(t.TempDir(), "sync.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		_ = database.Close()
	})

	store := db.NewStore(database)
	if err := store.EnsureWorkspace("alice", strongWorkspacePassword); err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}
	return New(store)
}

func withWorkspace(r *http.Request, workspace string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), workspaceKey, workspace))
}
