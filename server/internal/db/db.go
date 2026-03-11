package db

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(1)

	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("exec %q: %w", p, err)
		}
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	ddl := `
CREATE TABLE IF NOT EXISTS workspaces (
    workspace_name TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    version        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
    workspace_name TEXT NOT NULL,
    id             TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS ssh_keys (
    workspace_name TEXT NOT NULL,
    id             TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS proxies (
    workspace_name TEXT NOT NULL,
    id             TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS deleted_tombstones (
    workspace_name TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    TEXT NOT NULL,
    deleted_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, resource_type, resource_id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);
`
	_, err := db.Exec(ddl)
	return err
}
