package handler

import (
	"net/http"
	"time"

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
			Connections: snap.Connections,
			SSHKeys:     snap.SSHKeys,
			Proxies:     snap.Proxies,
			Deleted: model.DeletedIDs{
				Connections: snap.DeletedConnections,
				SSHKeys:     snap.DeletedSSHKeys,
				Proxies:     snap.DeletedProxies,
			},
		},
	})
}
