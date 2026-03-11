package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/hynor/nshellserver/internal/db"
)

type contextKey string

const workspaceKey contextKey = "workspace"

func WorkspaceName(ctx context.Context) string {
	return ctx.Value(workspaceKey).(string)
}

func (h *Handler) AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username == "" || password == "" {
			w.Header().Set("WWW-Authenticate", `Basic realm="nshell"`)
			writeError(w, http.StatusUnauthorized, "missing credentials")
			return
		}

		authScope := authFailureScope(username, clientIP(r.RemoteAddr))

		if h.RateLimiter.IsLockedOut(authScope) {
			w.Header().Set("Retry-After", "900")
			writeError(w, http.StatusTooManyRequests, "too many auth failures, try again later")
			return
		}

		if err := h.Store.EnsureWorkspace(username, password); err != nil {
			if errors.Is(err, db.ErrInvalidPassword) || errors.Is(err, db.ErrWorkspacePasswordTooShort) {
				h.RateLimiter.RecordAuthFailure(authScope)
				writeError(w, http.StatusUnauthorized, "invalid credentials")
			} else {
				writeError(w, http.StatusInternalServerError, "auth error")
			}
			return
		}

		ctx := context.WithValue(r.Context(), workspaceKey, username)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

const maxRequestBody = 10 << 20 // 10 MB

func authFailureScope(workspace, ip string) string {
	return workspace + "|" + ip
}

func BodyLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		next.ServeHTTP(w, r)
	})
}
