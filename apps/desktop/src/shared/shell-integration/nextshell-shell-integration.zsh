# NextShell shell integration (zsh)
#
# Installed by NextShell (SSH client) into $HOME/.cache/nextshell and sourced
# from the live shell (auto mode) or from ~/.zshrc (manual mode).
# Modeled after WezTerm's shell-integration.sh and iTerm2's it2_* hooks.
#
# Emits OSC 7 (cwd report) and OSC 133 A/B/C/D (prompt/command marks).
# Idempotent: the NEXTSHELL_INTEGRATED sentinel makes re-sourcing a no-op and
# every hook is registered without clobbering existing user configuration.

[ -n "${NEXTSHELL_INTEGRATED:-}" ] && return 0
NEXTSHELL_INTEGRATED=1

# Cache the hostname once at source time; it cannot change mid-session and
# forking `hostname` on every prompt is wasted work.
__nextshell_hostname=$(hostname 2>/dev/null || printf 'localhost')

__nextshell_emit_cwd() {
  printf '\033]7;file://%s%s\007' "$__nextshell_hostname" "$PWD"
}

# Remove terminal control bytes with zsh builtins only. Printable command text
# remains verbatim for OscTap and is never evaluated as shell source.
__nextshell_sanitize_command() {
  emulate -L zsh
  local LC_ALL=C
  local __nextshell_value=${1-}
  local __nextshell_char

  while (( ${#__nextshell_value} > 0 )); do
    __nextshell_char=${__nextshell_value[1]}
    __nextshell_value=${__nextshell_value[2,-1]}
    case "$__nextshell_char" in
      [[:cntrl:]]) ;;
      *) printf '%s' "$__nextshell_char" ;;
    esac
  done
}

# Runs FIRST among precmd hooks so `$?` is still the user's command status, and
# returns that same status so later hooks (starship, powerlevel10k, …) still
# observe the exit code they expect.
__nextshell_precmd() {
  local __nextshell_exit_code=$?
  if [ -n "${__nextshell_prompt_seen:-}" ]; then
    printf '\033]133;D;%s\007' "$__nextshell_exit_code"
  fi
  __nextshell_prompt_seen=1
  printf '\033]133;A\007'
  __nextshell_emit_cwd
  return $__nextshell_exit_code
}

# Runs LAST among precmd hooks: prompt frameworks rebuild PROMPT on every cycle,
# so the B mark (prompt end / input start) has to be re-appended after they ran
# rather than once at source time. %{ %} keeps zsh from counting the invisible
# bytes towards the line width.
__nextshell_prompt_end() {
  local __nextshell_exit_code=$?
  case "${PROMPT:-}" in
    *'133;B'*) ;;
    *) PROMPT="${PROMPT:-}%{$(printf '\033]133;B\007')%}" ;;
  esac
  return $__nextshell_exit_code
}

__nextshell_preexec() {
  printf '\033]133;C;'
  __nextshell_sanitize_command "${1-}"
  printf '\007'
}

# `${array[(I)pattern]}` yields the index of the last match, 0 when absent.
typeset -ga precmd_functions preexec_functions

if (( ! ${precmd_functions[(I)__nextshell_precmd]} )); then
  precmd_functions=(__nextshell_precmd $precmd_functions)
fi

if (( ! ${precmd_functions[(I)__nextshell_prompt_end]} )); then
  precmd_functions+=(__nextshell_prompt_end)
fi

if (( ! ${preexec_functions[(I)__nextshell_preexec]} )); then
  preexec_functions+=(__nextshell_preexec)
fi
