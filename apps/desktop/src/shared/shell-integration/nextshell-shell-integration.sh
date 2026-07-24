# NextShell shell integration (bash / zsh / POSIX sh)
#
# Installed by NextShell (SSH client) into $HOME/.cache/nextshell and sourced
# from the live shell (auto mode) or from ~/.bashrc / ~/.zshrc (manual mode).
# Modeled after WezTerm's shell-integration.sh and iTerm2's it2_* hooks.
#
# Emits OSC 7 (cwd report) and OSC 133 (prompt/command marks). Idempotent:
# the NEXTSHELL_INTEGRATED sentinel makes re-sourcing a no-op, and every hook
# is appended without clobbering existing user configuration.

[ -n "${NEXTSHELL_INTEGRATED:-}" ] && return
NEXTSHELL_INTEGRATED=1

# Cache the hostname once at source time; it cannot change mid-session and
# forking `hostname` on every prompt is wasted work.
__nextshell_hostname=$(hostname 2>/dev/null || printf 'localhost')

__nextshell_emit_cwd() {
  printf '\033]7;file://%s%s\007' "$__nextshell_hostname" "$PWD"
}

if [ -n "${BASH_VERSION:-}" ]; then
  # ── bash ────────────────────────────────────────────────────────────────
  # PROMPT_COMMAND is the only prompt hook bash has: it carries D (previous
  # command's exit code, skipped on the very first prompt so sourcing does
  # not fake a command end), A (prompt start) and the cwd report.
  __nextshell_prompt_command() {
    local __nextshell_exit_code=$?
    if [ -n "${__nextshell_prompt_seen:-}" ]; then
      printf '\033]133;D;%s\007' "$__nextshell_exit_code"
    fi
    __nextshell_prompt_seen=1
    printf '\033]133;A\007'
    __nextshell_emit_cwd
  }

  case ";${PROMPT_COMMAND:-};" in
    *";__nextshell_prompt_command;"*) ;;
    *) PROMPT_COMMAND="__nextshell_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac

  # PS0 (printed right after reading a command, before executing it) carries
  # C (output start). Only bash >= 4.4 supports PS0; never overwrite a
  # user-defined PS0.
  if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] 2>/dev/null ||
    { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; } 2>/dev/null; then
    if [ -z "${PS0:-}" ]; then
      PS0='\033]133;C\007'
    fi
  fi

  # B (prompt end / input start) rides at the end of PS1, wrapped in \[ \]
  # so bash does not count it towards the line width.
  case "${PS1:-}" in
    *'133;B'*) ;;
    *) PS1="${PS1:-}\[\033]133;B\007\]" ;;
  esac
elif [ -n "${ZSH_VERSION:-}" ]; then
  # ── zsh ─────────────────────────────────────────────────────────────────
  __nextshell_precmd() {
    local __nextshell_exit_code=$?
    if [ -n "${__nextshell_prompt_seen:-}" ]; then
      printf '\033]133;D;%s\007' "$__nextshell_exit_code"
    fi
    __nextshell_prompt_seen=1
    printf '\033]133;A\007'
    __nextshell_emit_cwd
  }

  __nextshell_preexec() {
    printf '\033]133;C\007'
  }

  autoload -Uz add-zsh-hook >/dev/null 2>&1 || true
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook precmd __nextshell_precmd
    add-zsh-hook preexec __nextshell_preexec
  else
    # Fallback for minimal zsh installs: append to the hook arrays directly.
    case " ${precmd_functions[*]:-} " in
      *" __nextshell_precmd "*) ;;
      *) precmd_functions+=(__nextshell_precmd) ;;
    esac
    case " ${preexec_functions[*]:-} " in
      *" __nextshell_preexec "*) ;;
      *) preexec_functions+=(__nextshell_preexec) ;;
    esac
  fi

  # B at the end of PROMPT; %{ %} keeps zsh from counting the invisible
  # bytes. The substitution runs once here, embedding the raw sequence.
  case "${PROMPT:-}" in
    *'133;B'*) ;;
    *) PROMPT="${PROMPT:-}%{$(printf '\033]133;B\007')%}" ;;
  esac
else
  # ── POSIX sh fallback ───────────────────────────────────────────────────
  # POSIX sh has no precmd/preexec hooks and no reliable way to capture the
  # previous exit code at prompt time, so only OSC 7 (cwd) is emitted via a
  # PS1 command substitution; OSC 133 marks are not possible here.
  case "${PS1:-}" in
    *'__nextshell_emit_cwd'*) ;;
    *) PS1="${PS1}\$(__nextshell_emit_cwd)" ;;
  esac
fi
