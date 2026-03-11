package handler

import (
	"errors"
	"net/http"

	"github.com/hynor/nshellserver/internal/db"
	"github.com/hynor/nshellserver/internal/model"
)

func (h *Handler) UpsertSSHKey(w http.ResponseWriter, r *http.Request) {
	ws := WorkspaceName(r.Context())

	var req model.UpsertSSHKeyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	id, err := extractID(req.SSHKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "sshKey must have an id field")
		return
	}

	version, updatedAt, err := h.Store.UpsertSSHKey(ws, id, req.SSHKey)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to upsert ssh key")
		return
	}

	writeJSON(w, http.StatusOK, model.UpsertResponse{
		OK:        true,
		Version:   version,
		UpdatedAt: updatedAt,
	})
}

func (h *Handler) DeleteSSHKey(w http.ResponseWriter, r *http.Request) {
	ws := WorkspaceName(r.Context())

	var req model.DeleteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}

	version, deletedAt, err := h.Store.DeleteSSHKey(ws, req.ID)
	if err != nil {
		var ce *db.ConflictError
		if errors.As(err, &ce) {
			writeError(w, http.StatusConflict, ce.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete ssh key")
		return
	}

	writeJSON(w, http.StatusOK, model.DeleteResponse{
		OK:        true,
		Version:   version,
		DeletedAt: deletedAt,
	})
}
