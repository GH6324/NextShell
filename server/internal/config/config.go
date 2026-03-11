package config

import (
	"flag"
	"os"
)

type Config struct {
	Addr     string
	CertFile string
	KeyFile  string
	DBPath   string
}

func Load() *Config {
	c := &Config{}
	flag.StringVar(&c.Addr, "addr", envOrDefault("NSHELL_ADDR", ":8443"), "listen address")
	flag.StringVar(&c.CertFile, "cert", envOrDefault("NSHELL_CERT", ""), "TLS certificate file")
	flag.StringVar(&c.KeyFile, "key", envOrDefault("NSHELL_KEY", ""), "TLS private key file")
	flag.StringVar(&c.DBPath, "db", envOrDefault("NSHELL_DB", "./nshell.db"), "SQLite database path")
	flag.Parse()
	return c
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
