package handler

import (
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// RateLimiter provides per-IP request rate limiting and per-workspace auth failure lockout.
type RateLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitorEntry
	authFail map[string]*authFailEntry
}

type visitorEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type authFailEntry struct {
	count       int
	windowStart time.Time
	lockedUntil time.Time
}

const (
	ipRateLimit     = 100 // requests per minute
	ipBurst         = 100
	authFailLimit   = 5 // failures per window
	authFailWindow  = 1 * time.Minute
	authLockoutDur  = 15 * time.Minute
	cleanupInterval = 5 * time.Minute
)

func NewRateLimiter() *RateLimiter {
	rl := &RateLimiter{
		visitors: make(map[string]*visitorEntry),
		authFail: make(map[string]*authFailEntry),
	}
	go rl.cleanupLoop()
	return rl
}

func (rl *RateLimiter) getVisitor(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	v, exists := rl.visitors[ip]
	if !exists {
		limiter := rate.NewLimiter(rate.Every(time.Minute/ipRateLimit), ipBurst)
		rl.visitors[ip] = &visitorEntry{limiter: limiter, lastSeen: time.Now()}
		return limiter
	}
	v.lastSeen = time.Now()
	return v.limiter
}

// IsLockedOut checks if a workspace is locked out due to auth failures.
func (rl *RateLimiter) IsLockedOut(workspace string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	entry, exists := rl.authFail[workspace]
	if !exists {
		return false
	}
	if time.Now().Before(entry.lockedUntil) {
		return true
	}
	return false
}

// RecordAuthFailure records an auth failure for a workspace and returns true if now locked out.
func (rl *RateLimiter) RecordAuthFailure(workspace string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	entry, exists := rl.authFail[workspace]
	if !exists || now.Sub(entry.windowStart) > authFailWindow {
		rl.authFail[workspace] = &authFailEntry{count: 1, windowStart: now}
		return false
	}
	entry.count++
	if entry.count >= authFailLimit {
		entry.lockedUntil = now.Add(authLockoutDur)
		return true
	}
	return false
}

// Middleware returns an HTTP middleware that enforces per-IP rate limiting.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r.RemoteAddr)
		limiter := rl.getVisitor(ip)
		if !limiter.Allow() {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) cleanupLoop() {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, v := range rl.visitors {
			if now.Sub(v.lastSeen) > cleanupInterval {
				delete(rl.visitors, ip)
			}
		}
		for ws, entry := range rl.authFail {
			if now.After(entry.lockedUntil) && now.Sub(entry.windowStart) > authFailWindow {
				delete(rl.authFail, ws)
			}
		}
		rl.mu.Unlock()
	}
}

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}
