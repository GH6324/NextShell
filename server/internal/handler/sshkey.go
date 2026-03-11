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

	workspaceVersion, resourceRevision, updatedAt, conflict, err := h.Store.UpsertSSHKey(ws, id, req.SSHKey, req.BaseRevision, req.Force)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to upsert ssh key")
		return
	}
	if conflict != nil {
		writeJSON(w, http.StatusConflict, model.ConflictResponse{
			OK:    false,
			Error: "conflict",
			Conflict: model.ResourceConflictInfo{
				ResourceType:    conflict.ResourceType,
				ResourceID:      conflict.ResourceID,
				ServerRevision:  conflict.ServerRevision,
				ServerUpdatedAt: conflict.ServerUpdatedAt,
				ServerDeleted:   conflict.ServerDeleted,
				ServerPayload:   conflict.ServerPayload,
			},
		})
		return
	}

	writeJSON(w, http.StatusOK, model.UpsertResponse{
		OK:               true,
		WorkspaceVersion: workspaceVersion,
		ResourceRevision: resourceRevision,
		UpdatedAt:        updatedAt,
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

	workspaceVersion, resourceRevision, deletedAt, conflict, err := h.Store.DeleteSSHKey(ws, req.ID, req.BaseRevision, req.Force)
	if err != nil {
		var ce *db.ConflictError
		if errors.As(err, &ce) {
			writeError(w, http.StatusConflict, ce.Message)
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete ssh key")
		return
	}
	if conflict != nil {
		writeJSON(w, http.StatusConflict, model.ConflictResponse{
			OK:    false,
			Error: "conflict",
			Conflict: model.ResourceConflictInfo{
				ResourceType:    conflict.ResourceType,
				ResourceID:      conflict.ResourceID,
				ServerRevision:  conflict.ServerRevision,
				ServerUpdatedAt: conflict.ServerUpdatedAt,
				ServerDeleted:   conflict.ServerDeleted,
				ServerPayload:   conflict.ServerPayload,
			},
		})
		return
	}

	writeJSON(w, http.StatusOK, model.DeleteResponse{
		OK:               true,
		WorkspaceVersion: workspaceVersion,
		ResourceRevision: resourceRevision,
		DeletedAt:        deletedAt,
	})
}
