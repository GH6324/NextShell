package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/hynor/nshellserver/internal/db"
)

const strongWorkspacePassword = "secret-123"

func TestAuthMiddlewareRejectsShortNewWorkspacePassword(t *testing.T) {
	h := newMiddlewareTestHandler(t)
	handler := h.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/api/v1/sync/workspace/status", nil)
	request.SetBasicAuth("new-workspace", "short")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for short workspace password, got %d", recorder.Code)
	}
}

func TestAuthMiddlewareLocksWorkspaceAfterRepeatedFailures(t *testing.T) {
	h := newMiddlewareTestHandler(t)
	handler := h.AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for range 5 {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/sync/workspace/status", nil)
		request.SetBasicAuth("alice", "wrong-password")
		request.RemoteAddr = "198.51.100.7:4000"
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("expected wrong password attempt to return 401, got %d", recorder.Code)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/sync/workspace/status", nil)
	request.SetBasicAuth("alice", "wrong-password")
	request.RemoteAddr = "198.51.100.7:4001"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected lockout to return 429, got %d", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") != "900" {
		t.Fatalf("expected auth lockout retry-after header")
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/sync/workspace/status", nil)
	request.SetBasicAuth("alice", strongWorkspacePassword)
	request.RemoteAddr = "203.0.113.9:5000"
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected different client IP to bypass workspace lockout, got %d", recorder.Code)
	}
}

func TestRateLimiterUsesClientIPNotEphemeralPort(t *testing.T) {
	limiter := NewRateLimiter()
	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for attempt := 0; attempt < 100; attempt++ {
		request := httptest.NewRequest(http.MethodGet, "/health", nil)
		request.RemoteAddr = "198.51.100.7:" + strconv.Itoa(2000+attempt)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusNoContent {
			t.Fatalf("expected attempt %d to be allowed, got %d", attempt+1, recorder.Code)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	request.RemoteAddr = "198.51.100.7:9999"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 101st request from same IP to be rate limited, got %d", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") != "60" {
		t.Fatalf("expected rate limit retry-after header")
	}
}

func newMiddlewareTestHandler(t *testing.T) *Handler {
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
