package db

import (
	"database/sql"
	"fmt"
	"strings"

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
    revision       INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS ssh_keys (
    workspace_name TEXT NOT NULL,
    id             TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS proxies (
    workspace_name TEXT NOT NULL,
    id             TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);

CREATE TABLE IF NOT EXISTS deleted_tombstones (
    workspace_name TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    TEXT NOT NULL,
    revision       INTEGER NOT NULL DEFAULT 0,
    deleted_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_name, resource_type, resource_id),
    FOREIGN KEY (workspace_name) REFERENCES workspaces(workspace_name)
);
`
	if _, err := db.Exec(ddl); err != nil {
		return err
	}

	columnSpecs := map[string][]string{
		"connections":        {"revision INTEGER NOT NULL DEFAULT 0"},
		"ssh_keys":           {"revision INTEGER NOT NULL DEFAULT 0"},
		"proxies":            {"revision INTEGER NOT NULL DEFAULT 0"},
		"deleted_tombstones": {"revision INTEGER NOT NULL DEFAULT 0"},
	}
	for table, specs := range columnSpecs {
		for _, spec := range specs {
			if err := ensureColumn(db, table, spec); err != nil {
				return err
			}
		}
	}

	return nil
}

func ensureColumn(db *sql.DB, table, columnSpec string) error {
	columnName := strings.Fields(columnSpec)
	if len(columnName) == 0 {
		return fmt.Errorf("invalid column spec for %s", table)
	}
	pragmaRows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return fmt.Errorf("pragma %s: %w", table, err)
	}
	defer pragmaRows.Close()

	for pragmaRows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := pragmaRows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("scan pragma %s: %w", table, err)
		}
		if name == columnName[0] {
			return nil
		}
	}
	if err := pragmaRows.Err(); err != nil {
		return fmt.Errorf("iterate pragma %s: %w", table, err)
	}

	if _, err := db.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s`, table, columnSpec)); err != nil {
		return fmt.Errorf("alter %s add %s: %w", table, columnSpec, err)
	}
	return nil
}
