package handler

import (
	"encoding/json"
	"net/http"

	"github.com/hynor/nshellserver/internal/db"
)

type Handler struct {
	Store       *db.Store
	RateLimiter *RateLimiter
}

func New(store *db.Store) *Handler {
	return &Handler{Store: store, RateLimiter: NewRateLimiter()}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": msg,
	})
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
