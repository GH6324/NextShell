# NextShell shell integration (POSIX sh — dash, ash, busybox sh)
#
# Installed by NextShell (SSH client) into $HOME/.cache/nextshell and sourced
# from the live shell (auto mode) or from the login profile (manual mode).
#
# Strictly POSIX: no arrays, no `[[`, no `local`. POSIX sh has neither precmd
# nor preexec hooks and no reliable way to read the previous exit code at
# prompt time, so this file only emits OSC 7 (cwd report) through a PS1
# command substitution — OSC 133 marks are not possible here. bash and zsh get
# their own files with the full mark set.
#
# Idempotent: the NEXTSHELL_INTEGRATED sentinel makes re-sourcing a no-op and
# PS1 is appended to, never overwritten.

[ -n "${NEXTSHELL_INTEGRATED:-}" ] && return 0
NEXTSHELL_INTEGRATED=1

# Cache the hostname once at source time; it cannot change mid-session and
# forking `hostname` on every prompt is wasted work.
__nextshell_hostname=$(hostname 2>/dev/null || printf 'localhost')

__nextshell_emit_cwd() {
  printf '\033]7;file://%s%s\007' "$__nextshell_hostname" "$PWD"
}

case "${PS1:-}" in
  *__nextshell_emit_cwd*) ;;
  *) PS1="${PS1:-}\$(__nextshell_emit_cwd)" ;;
esac
