#!/usr/bin/env bash
#
# Create the stable self-signed code-signing certificate used by NextShell's
# beta builds (see KEYCHAIN_UX_PLAN.md §9, path B).
#
# Why this exists: the macOS keychain matches "Always Allow" against an app's
# designated requirement. Ad-hoc signing derives that from the cdhash, which
# changes on every build — so every release would ask for keychain
# authorization all over again. Signing every build with the SAME certificate
# keeps the requirement stable, and the user's "Always Allow" sticks.
#
# Gatekeeper still warns on downloaded builds (self-signed cannot be
# notarized); that is the accepted trade-off while the app is in beta.
#
# WARNING: never delete or regenerate this certificate once builds have shipped
# with it. A new certificate means a new designated requirement, and every user
# gets prompted again.
#
# Usage:
#   ./apps/desktop/scripts/create-signing-cert.sh              # create + trust + export
#   CERT_NAME="Other Name" ./…/create-signing-cert.sh          # custom common name
#
set -euo pipefail

CERT_NAME="${CERT_NAME:-NextShell Dev}"
OUT_DIR="${OUT_DIR:-$HOME/.nextshell-signing}"
VALID_DAYS="${VALID_DAYS:-3650}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script only applies to macOS." >&2
  exit 1
fi

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

# ── Already installed? ───────────────────────────────────────────────────────
if security find-identity -v -p codesigning | grep -qF "$CERT_NAME"; then
  say "Code-signing identity \"$CERT_NAME\" already exists — nothing to create."
  security find-identity -v -p codesigning | grep -F "$CERT_NAME"
  if [[ -f "$OUT_DIR/signing-cert.p12" ]]; then
    echo
    say "CI secrets (from the existing export at $OUT_DIR):"
    echo "  MACOS_CERT_P12_BASE64 = $(base64 -i "$OUT_DIR/signing-cert.p12" | tr -d '\n' | head -c 24)… (run: base64 -i $OUT_DIR/signing-cert.p12 | pbcopy)"
    echo "  MACOS_CERT_PASSWORD   = (the password stored in $OUT_DIR/p12-password.txt)"
  fi
  exit 0
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

P12_PASSWORD="${P12_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n')}"
KEY_PATH="$OUT_DIR/signing-key.pem"
CERT_PATH="$OUT_DIR/signing-cert.pem"
P12_PATH="$OUT_DIR/signing-cert.p12"
CONFIG_PATH="$(mktemp -t nextshell-codesign-cnf)"

trap 'rm -f "$CONFIG_PATH"' EXIT

# LibreSSL (the system openssl) has spotty `-addext` support, so drive the
# extensions from a config file instead.
cat >"$CONFIG_PATH" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = codesign
prompt             = no

[ dn ]
CN = $CERT_NAME

[ codesign ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
EOF

say "Generating a $VALID_DAYS-day self-signed code-signing certificate: $CERT_NAME"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY_PATH" -out "$CERT_PATH" \
  -days "$VALID_DAYS" -config "$CONFIG_PATH" >/dev/null 2>&1

openssl pkcs12 -export -inkey "$KEY_PATH" -in "$CERT_PATH" \
  -out "$P12_PATH" -name "$CERT_NAME" -passout "pass:$P12_PASSWORD" >/dev/null 2>&1

printf '%s\n' "$P12_PASSWORD" >"$OUT_DIR/p12-password.txt"
chmod 600 "$OUT_DIR"/*

say "Importing into the login keychain"
# -A lets codesign use the key without a per-signature confirmation dialog.
security import "$P12_PATH" -k "$KEYCHAIN" -P "$P12_PASSWORD" -A \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null

say "Marking it trusted for code signing (macOS may ask for your login password)"
# The user trust domain is enough for codesign; it avoids needing sudo.
if ! security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_PATH" 2>/dev/null; then
  cat >&2 <<EOF

Could not set trust automatically. Run this yourself and re-run the script:

  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$CERT_PATH"

EOF
  exit 1
fi

say "Verifying"
if ! security find-identity -v -p codesigning | grep -qF "$CERT_NAME"; then
  echo "Identity was imported but is not valid for code signing. Check Keychain Access → 证书 → $CERT_NAME → 信任 → 代码签名 = 始终信任." >&2
  exit 1
fi
security find-identity -v -p codesigning | grep -F "$CERT_NAME"

cat <<EOF

Done. Local signed builds:

  pnpm --filter @nextshell/desktop run dist:mac

For CI, add these GitHub repository secrets:

  MACOS_CERT_P12_BASE64   base64 -i "$P12_PATH" | pbcopy
  MACOS_CERT_PASSWORD     cat "$OUT_DIR/p12-password.txt"

Keep $OUT_DIR backed up somewhere safe. Losing this certificate means every
user gets re-prompted for keychain access after the next release.
EOF
