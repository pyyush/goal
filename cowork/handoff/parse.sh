#!/usr/bin/env bash
# cowork/handoff/parse.sh — bash parser for .goal/handoff/NNNN.md envelopes
#
# Intended to be sourced by other shell tools. Pure bash + grep/sed/awk.
# No external dependencies beyond what the hooks already use.
#
# Functions:
#   handoff_parse_seq   <file>           — print seq value from frontmatter
#   handoff_parse_field <file> <key>     — print one frontmatter value
#   handoff_parse_body  <file> <section> — print one body section's bullets
#   handoff_validate    <file>           — exit 0 if shape matches §5.2
#
# Section names for handoff_parse_body:
#   did | did_not | next | do_not_redo | open_audit | evidence
#
# Usage example:
#   . /path/to/parse.sh
#   handoff_validate .goal/handoff/0001.md || exit 1
#   seq=$(handoff_parse_seq .goal/handoff/0001.md)
#   from=$(handoff_parse_field .goal/handoff/0001.md from)
#   bullets=$(handoff_parse_body .goal/handoff/0001.md next)

# ---- internal helpers -------------------------------------------------------

# _handoff_frontmatter_block <file>
# Print only the YAML frontmatter (between the first pair of --- lines).
_handoff_frontmatter_block() {
    awk '
        /^---[[:space:]]*$/ { if (NR == 1 || in_front) { in_front = !in_front; next } }
        in_front { print }
    ' "$1"
}

# _handoff_section_header_re <section>
# Return the regex that matches the ## header for a given section name.
_handoff_section_header_re() {
    case "$1" in
        did)         printf '^## Did$' ;;
        did_not)     printf '^## Did not$' ;;
        next)        printf '^## Next$' ;;
        do_not_redo) printf '^## Do not redo$' ;;
        open_audit)  printf '^## Open audit items$' ;;
        evidence)    printf '^## Evidence$' ;;
        *)           printf '' ;;
    esac
}

# ---- public functions -------------------------------------------------------

# handoff_parse_seq <file>
# Print the seq value from the frontmatter (e.g. "0007"). Exits 1 on miss.
handoff_parse_seq() {
    handoff_parse_field "$1" seq
}

# handoff_parse_field <file> <key>
# Print one frontmatter value. Exits 1 if key not found.
handoff_parse_field() {
    local file="$1" key="$2"
    local val
    val=$(_handoff_frontmatter_block "$file" | \
        grep -E "^${key}:[[:space:]]" | head -1 | \
        sed "s/^${key}:[[:space:]]*//" | sed 's/[[:space:]]*$//')
    if [ -z "$val" ]; then
        return 1
    fi
    printf '%s\n' "$val"
}

# handoff_parse_body <file> <section>
# Print the bullet lines for a named body section, one per line.
# Section names: did | did_not | next | do_not_redo | open_audit | evidence
# Outputs only lines that start with "- " (markdown bullets).
handoff_parse_body() {
    local file="$1" section="$2"
    local hdr_re
    hdr_re=$(_handoff_section_header_re "$section")
    if [ -z "$hdr_re" ]; then
        printf 'handoff_parse_body: unknown section "%s"\n' "$section" >&2
        return 1
    fi

    awk -v hdr="$hdr_re" '
        # Skip the frontmatter block entirely.
        /^---[[:space:]]*$/ {
            if (NR == 1) { in_front = 1; next }
            if (in_front) { in_front = 0; next }
        }
        in_front { next }

        # Track which section we are in.
        /^## / {
            if ($0 ~ hdr) { in_section = 1 } else { in_section = 0 }
            next
        }

        # Print bullet lines in the target section.
        in_section && /^- / { print }
    ' "$file"
}

# handoff_validate <file>
# Exit 0 if file has the §5.2 shape: required frontmatter keys present and
# all six body section headers present. On failure, print a message to stderr
# naming the missing piece and exit non-zero.
handoff_validate() {
    local file="$1"

    if [ ! -f "$file" ]; then
        printf 'handoff_validate: file not found: %s\n' "$file" >&2
        return 1
    fi

    # Required frontmatter keys.
    local key
    for key in seq from to at reason goal_id; do
        local val
        val=$(handoff_parse_field "$file" "$key" 2>/dev/null) || true
        if [ -z "$val" ]; then
            printf 'handoff_validate: missing frontmatter key "%s" in %s\n' "$key" "$file" >&2
            return 1
        fi
    done

    # Validate reason enum.
    local reason
    reason=$(handoff_parse_field "$file" reason)
    case "$reason" in
        planned|rate_limit|budget_step_down|error|user) ;;
        *)
            printf 'handoff_validate: invalid reason value "%s" in %s\n' "$reason" "$file" >&2
            return 1
            ;;
    esac

    # Required body section headers.
    local section hdr
    for section in did did_not next do_not_redo open_audit evidence; do
        hdr=$(_handoff_section_header_re "$section")
        if ! grep -qE "$hdr" "$file"; then
            printf 'handoff_validate: missing section "%s" in %s\n' "$section" "$file" >&2
            return 1
        fi
    done

    return 0
}
