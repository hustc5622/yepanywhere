#!/usr/bin/env bash
set -euo pipefail

# Generate a reusable 10-year Private Root CA and an IP/DNS leaf TLS
# certificate for Yep Anywhere's dedicated TLS listener (TLS_PORT).
#
# Why a Private Root CA instead of a plain self-signed cert?
# - Install the Root CA once on your Mac / iOS / Android APK.
# - Whenever your frp IP changes, re-run this script with the new IP(s);
#   the existing Root CA is reused so your devices keep trusting it
#   automatically without re-installing anything.
# - Pure-IP HTTPS omits the TLS SNI extension (RFC 6066), so domestic TCP frp
#   nodes that block un-filed domain SNI pass the TLS 1.3 connection cleanly.

DATA_DIR="${YEP_ANYWHERE_DATA_DIR:-$HOME/.yep-anywhere}"
TLS_DIR="${YEP_TLS_DIR:-$DATA_DIR/tls}"
CA_KEY="$TLS_DIR/yep-root-ca.key"
CA_CERT="$TLS_DIR/yep-root-ca.crt"
SERVER_KEY="$TLS_DIR/server.key"
SERVER_CERT="$TLS_DIR/server.crt"
SERVER_CSR="$TLS_DIR/server.csr"

IPS=()
DOMAINS=()
FORCE_CA=false

usage() {
  cat <<'EOF'
Usage: scripts/setup-private-tls.sh [OPTIONS]

Options:
  --ip <ipv4>          Public or LAN IP to include in certificate SAN (repeatable)
  --domain <hostname>  Optional domain name to include in SAN (repeatable)
  --tls-dir <dir>      Output directory (default: ~/.yep-anywhere/tls)
  --force-ca           Regenerate the Private Root CA (devices must re-trust it)
  -h, --help           Show this help

Examples:
  scripts/setup-private-tls.sh --ip 39.106.189.88
  scripts/setup-private-tls.sh --ip 39.106.189.88 --ip 47.95.254.240
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)
      [[ $# -ge 2 ]] || { echo "Missing value for --ip" >&2; exit 1; }
      IPS+=("$2")
      shift 2
      ;;
    --domain)
      [[ $# -ge 2 ]] || { echo "Missing value for --domain" >&2; exit 1; }
      DOMAINS+=("$2")
      shift 2
      ;;
    --tls-dir)
      [[ $# -ge 2 ]] || { echo "Missing value for --tls-dir" >&2; exit 1; }
      TLS_DIR="$2"
      CA_KEY="$TLS_DIR/yep-root-ca.key"
      CA_CERT="$TLS_DIR/yep-root-ca.crt"
      SERVER_KEY="$TLS_DIR/server.key"
      SERVER_CERT="$TLS_DIR/server.crt"
      SERVER_CSR="$TLS_DIR/server.csr"
      shift 2
      ;;
    --force-ca)
      FORCE_CA=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is required but was not found in PATH." >&2
  exit 1
fi

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

if [[ "$FORCE_CA" == true ]] || [[ ! -f "$CA_KEY" ]] || [[ ! -f "$CA_CERT" ]]; then
  echo "[TLS] Generating 10-year Private Root CA..."
  CA_CONF="$(mktemp)"
  cat >"$CA_CONF" <<'EOF'
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
CN = Yep Anywhere Private Root CA
O = Yep Anywhere Self-Hosted

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
EOF
  openssl genrsa -out "$CA_KEY" 4096 >/dev/null 2>&1
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 \
    -out "$CA_CERT" -config "$CA_CONF"
  rm -f "$CA_CONF"
  echo "[TLS] Created Root CA: $CA_CERT"
else
  echo "[TLS] Reusing existing Root CA: $CA_CERT"
fi

# Build SAN list (always include localhost + 127.0.0.1)
SAN_ENTRIES=("DNS:localhost" "IP:127.0.0.1")
for ip in "${IPS[@]+"${IPS[@]}"}"; do
  SAN_ENTRIES+=("IP:${ip}")
done
for domain in "${DOMAINS[@]+"${DOMAINS[@]}"}"; do
  SAN_ENTRIES+=("DNS:${domain}")
done

SAN_LINE="$(IFS=,; echo "${SAN_ENTRIES[*]}")"
CN_VALUE="${DOMAINS[0]:-${IPS[0]:-127.0.0.1}}"

LEAF_CONF="$(mktemp)"
cat >"$LEAF_CONF" <<EOF
[req]
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
CN = ${CN_VALUE}

[v3_ext]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = ${SAN_LINE}
EOF

TMP_KEY="$TLS_DIR/server.key.tmp"
TMP_CERT="$TLS_DIR/server.crt.tmp"
openssl genrsa -out "$TMP_KEY" 2048 >/dev/null 2>&1
chmod 600 "$TMP_KEY"
openssl req -new -key "$TMP_KEY" -out "$SERVER_CSR" -config "$LEAF_CONF"
openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$TMP_CERT" -days 825 -sha256 \
  -extfile "$LEAF_CONF" -extensions v3_ext >/dev/null 2>&1

# Atomic replace so Yep's hot-reload watcher observes complete files.
mv "$TMP_KEY" "$SERVER_KEY"
mv "$TMP_CERT" "$SERVER_CERT"
chmod 600 "$SERVER_KEY"
chmod 644 "$SERVER_CERT"
rm -f "$SERVER_CSR" "$LEAF_CONF"

echo ""
echo "[TLS] Server certificate ready!"
echo "  Root CA (install once on devices): $CA_CERT"
echo "  Server cert (TLS_CERT_PATH):       $SERVER_CERT"
echo "  Server key  (TLS_KEY_PATH):        $SERVER_KEY"
echo "  SANs:                              $SAN_LINE"
echo ""
echo "Next steps:"
echo "  1. Trust Root CA on macOS:"
echo "     sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$CA_CERT\""
echo "  2. On iPhone/iPad: AirDrop \"$CA_CERT\" -> Settings -> Profile Downloaded -> Install ->"
echo "     Settings -> General -> About -> Certificate Trust Settings -> Enable full trust."
echo "  3. Start/deploy Yep with:"
echo "     TLS_PORT=8443 TLS_CERT_PATH=\"$SERVER_CERT\" TLS_KEY_PATH=\"$SERVER_KEY\""
