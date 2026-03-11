package handler

import (
	"encoding/json"
	"net/http"

	"github.com/hynor/nshellserver/internal/model"
)

func (h *Handler) UpsertConnection(w http.ResponseWriter, r *http.Request) {
	ws := WorkspaceName(r.Context())

	var req model.UpsertConnectionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	id, err := extractID(req.Connection)
	if err != nil {
		writeError(w, http.StatusBadRequest, "connection must have an id field")
		return
	}

	workspaceVersion, resourceRevision, updatedAt, conflict, err := h.Store.UpsertConnection(ws, id, req.Connection, req.BaseRevision, req.Force)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to upsert connection")
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

func (h *Handler) DeleteConnection(w http.ResponseWriter, r *http.Request) {
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

	workspaceVersion, resourceRevision, deletedAt, conflict, err := h.Store.DeleteConnection(ws, req.ID, req.BaseRevision, req.Force)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete connection")
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

func extractID(raw json.RawMessage) (string, error) {
	var obj struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", err
	}
	if obj.ID == "" {
		return "", json.Unmarshal([]byte(`{}`), &struct{}{})
	}
	return obj.ID, nil
}
