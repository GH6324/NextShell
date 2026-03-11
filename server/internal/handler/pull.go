package handler

import (
	"net/http"
	"time"

	"github.com/hynor/nshellserver/internal/db"
	"github.com/hynor/nshellserver/internal/model"
)

func (h *Handler) Pull(w http.ResponseWriter, r *http.Request) {
	ws := WorkspaceName(r.Context())

	var req model.PullRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	snap, version, err := h.Store.PullSnapshot(ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to pull snapshot")
		return
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)

	if req.KnownVersion == version {
		writeJSON(w, http.StatusOK, model.PullResponse{
			OK:         true,
			Workspace:  ws,
			Version:    version,
			Unchanged:  true,
			ServerTime: now,
		})
		return
	}

	writeJSON(w, http.StatusOK, model.PullResponse{
		OK:         true,
		Workspace:  ws,
		Version:    version,
		Unchanged:  false,
		ServerTime: now,
		Snapshot: &model.Snapshot{
			Connections: mapResourceSnapshots(snap.Connections),
			SSHKeys:     mapResourceSnapshots(snap.SSHKeys),
			Proxies:     mapResourceSnapshots(snap.Proxies),
			Deleted: model.DeletedResources{
				Connections: mapDeletedResources(snap.DeletedConnections),
				SSHKeys:     mapDeletedResources(snap.DeletedSSHKeys),
				Proxies:     mapDeletedResources(snap.DeletedProxies),
			},
		},
	})
}

func mapResourceSnapshots(items []db.ResourceSnapshot) []model.ResourceSnapshot {
	result := make([]model.ResourceSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, model.ResourceSnapshot{
			Payload:   item.Payload,
			Revision:  item.Revision,
			UpdatedAt: item.UpdatedAt,
		})
	}
	return result
}

func mapDeletedResources(items []db.DeletedResource) []model.DeletedResource {
	result := make([]model.DeletedResource, 0, len(items))
	for _, item := range items {
		result = append(result, model.DeletedResource{
			ID:        item.ID,
			Revision:  item.Revision,
			DeletedAt: item.DeletedAt,
		})
	}
	return result
}
