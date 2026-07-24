# NextShell shell integration (fish)
#
# Installed by NextShell (SSH client) into $HOME/.cache/nextshell and sourced
# from the live shell (auto mode) or from ~/.config/fish/config.fish (manual
# mode). Modeled after WezTerm's and iTerm2's shell integration hooks.
#
# Emits OSC 7 (cwd report) and OSC 133 A/C/D marks. The B mark (prompt end)
# is omitted: fish paints its prompt inside the fish_prompt function, so a
# generic append-to-PROMPT hook does not exist; NextShell's renderer treats
# B as optional. Idempotent: the NEXTSHELL_INTEGRATED sentinel guards the
# whole body, and fish's --on-event handlers never touch user functions.

if not set -q NEXTSHELL_INTEGRATED
    set -g NEXTSHELL_INTEGRATED 1

    # Cache the hostname once at source time; it cannot change mid-session.
    set -g __nextshell_hostname (hostname 2>/dev/null; or echo localhost)

    function __nextshell_emit_cwd
        printf '\033]7;file://%s%s\007' "$__nextshell_hostname" "$PWD"
    end

    function __nextshell_on_prompt --on-event fish_prompt
        set -l __nextshell_exit_code $status
        if set -q __nextshell_prompt_seen
            printf '\033]133;D;%s\007' $__nextshell_exit_code
        end
        set -g __nextshell_prompt_seen 1
        printf '\033]133;A\007'
        __nextshell_emit_cwd
    end

    function __nextshell_preexec --on-event fish_preexec
        printf '\033]133;C\007'
    end
end
