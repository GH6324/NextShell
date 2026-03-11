package handler

import (
	"context"
	"net/http"
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

		if err := h.Store.EnsureWorkspace(username, password); err != nil {
			if err.Error() == "invalid password" {
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

func BodyLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		next.ServeHTTP(w, r)
	})
}
