# NextShell shell integration (bash)
#
# Installed by NextShell (SSH client) into $HOME/.cache/nextshell and sourced
# from the live shell (auto mode) or from ~/.bashrc (manual mode).
# Modeled after WezTerm's shell-integration.sh and iTerm2's it2_* hooks.
#
# Emits OSC 7 (cwd report) and OSC 133 A/B/C/D (prompt/command marks).
# One file per shell family on purpose: bash, zsh and POSIX sh do not share a
# parseable syntax subset (a bash/zsh array literal is a *parse* error in
# dash, which would take the whole script down before any branch runs).
#
# Idempotent: the NEXTSHELL_INTEGRATED sentinel makes re-sourcing a no-op and
# every hook is appended without clobbering existing user configuration.

[ -n "${NEXTSHELL_INTEGRATED:-}" ] && return 0
NEXTSHELL_INTEGRATED=1

# Cache the hostname once at source time; it cannot change mid-session and
# forking `hostname` on every prompt is wasted work.
__nextshell_hostname=$(hostname 2>/dev/null || printf 'localhost')

__nextshell_emit_cwd() {
  printf '\033]7;file://%s%s\007' "$__nextshell_hostname" "$PWD"
}

# Runs FIRST in PROMPT_COMMAND so `$?` is still the user's command status, and
# returns that same status so later PROMPT_COMMAND entries (starship, powerline,
# …) still observe the exit code they expect.
__nextshell_prompt_start() {
  local __nextshell_exit_code=$?
  if [ -n "${__nextshell_prompt_seen:-}" ]; then
    printf '\033]133;D;%s\007' "$__nextshell_exit_code"
  fi
  __nextshell_prompt_seen=1
  printf '\033]133;A\007'
  __nextshell_emit_cwd
  return "$__nextshell_exit_code"
}

# Runs LAST in PROMPT_COMMAND: prompt frameworks rebuild PS1 on every cycle, so
# the B mark (prompt end / input start) has to be re-appended after they ran
# rather than once at source time. `\[ \]` keeps bash from counting the
# invisible bytes towards the line width.
__nextshell_prompt_end() {
  local __nextshell_exit_code=$?
  case "${PS1:-}" in
    *'133;B'*) ;;
    *) PS1="${PS1:-}\[\033]133;B\007\]" ;;
  esac
  return "$__nextshell_exit_code"
}

__nextshell_install_prompt_hooks() {
  local declaration
  declaration=$(declare -p PROMPT_COMMAND 2>/dev/null)

  # bash >= 5.1 allows PROMPT_COMMAND to be an array; assigning a string to it
  # would silently drop every entry but the first.
  case "$declaration" in
    'declare -a'* | 'typeset -a'*)
      local entry
      for entry in "${PROMPT_COMMAND[@]}"; do
        case "$entry" in
          *__nextshell_prompt_start*) return 0 ;;
        esac
      done
      PROMPT_COMMAND=(__nextshell_prompt_start "${PROMPT_COMMAND[@]}" __nextshell_prompt_end)
      return 0
      ;;
  esac

  case "${PROMPT_COMMAND:-}" in
    *__nextshell_prompt_start*) return 0 ;;
  esac

  # Newline, not `;`, as the separator: a PROMPT_COMMAND that already ends in a
  # separator (`history -a; ` is a common one) would otherwise splice into
  # `history -a; ;__nextshell_prompt_end`, an empty command between two `;` —
  # a syntax error that kills the whole prompt on every cycle. A trailing `;`
  # before a newline is valid, and so is an empty line.
  PROMPT_COMMAND="__nextshell_prompt_start
${PROMPT_COMMAND:-}
__nextshell_prompt_end"
}

__nextshell_install_prompt_hooks
unset -f __nextshell_install_prompt_hooks

# PS0 is printed right after a command is read and before it runs, which is
# exactly the C mark (output start). bash >= 4.4 only. Appended, never
# overwritten — PS0 goes through prompt expansion, so `\nnn` octal escapes
# produce the raw control bytes.
if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] ||
  { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
  case "${PS0:-}" in
    *'133;C'*) ;;
    *) PS0="${PS0:-}\033]133;C\007" ;;
  esac
fi
