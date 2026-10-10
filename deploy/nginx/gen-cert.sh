#!/usr/bin/env bash
# Dockyard self-signed certificate generator.
#
#   gen-cert.sh NAME CERTS_DIR [--force]
#
# NAME      a DNS name (dockyard.example.com) or an IP address (203.0.113.10). It becomes the
#           certificate CN and the single subjectAltName entry, typed DNS: or IP: to match, so both
#           a browser reaching the panel by name and curl reaching it by address can validate it.
# CERTS_DIR the directory install.sh bind-mounts at /etc/nginx/certs. The pair is written to
#           CERTS_DIR/<NAME>/fullchain.pem and CERTS_DIR/<NAME>/privkey.pem, which the nginx config
#           references as <NAME>/fullchain.pem and <NAME>/privkey.pem relative to /etc/nginx/certs
#           (the @@CERT_FILE@@ and @@KEY_FILE@@ placeholders). A directory per name mirrors
#           certbot's /etc/letsencrypt/live/<name>/ layout and keeps one name's key from overwriting
#           another's when a second certificate is generated. For a self-signed pair "fullchain" is
#           just the leaf certificate; the name is kept so the same config works for an issued one.
# --force   replace an existing pair even if it is still valid.
#
# Re-running without --force is a no-op when a valid, unexpired pair is already present, so
# install.sh can call it on every run without rotating a certificate the browser already trusts.
# The script prints CERT_FILE= and KEY_FILE= lines with the paths relative to CERTS_DIR for the
# caller to render into the nginx template.
set -Eeuo pipefail
# A world-readable private key is the one mistake this script must never make. Set the umask before
# openssl creates anything, then chmod the key explicitly below.
umask 077

usage() {
  printf 'usage: %s NAME CERTS_DIR [--force]\n' "$(basename "$0")" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
NAME="$1"
CERTS_DIR="$2"
FORCE="no"
for arg in "${@:3}"; do
  case "$arg" in
    --force) FORCE="yes" ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; usage ;;
  esac
done

[ -n "$NAME" ] || { printf 'NAME must not be empty\n' >&2; exit 2; }
[ -n "$CERTS_DIR" ] || { printf 'CERTS_DIR must not be empty\n' >&2; exit 2; }

if ! command -v openssl >/dev/null 2>&1; then
  printf 'openssl is required but was not found on PATH\n' >&2
  exit 1
fi

# NAME is used both as a directory name and inside the subjectAltName, so refuse anything that
# could escape the certs directory or be read as an option.
case "$NAME" in
  ""|-*|.*|*/*)
    printf 'refusing NAME %q: expected a plain hostname or IP address\n' "$NAME" >&2
    exit 2
    ;;
esac

OUT_DIR="$CERTS_DIR/$NAME"
CERT="$OUT_DIR/fullchain.pem"
KEY="$OUT_DIR/privkey.pem"

# An IP literal must go in an IP: SAN and a hostname in a DNS: SAN; openssl rejects the wrong type.
# Four dotted octets is IPv4; anything containing a colon is treated as IPv6.
SAN="DNS:$NAME"
if [[ "$NAME" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$NAME" == *:* ]]; then
  SAN="IP:$NAME"
fi

# Idempotent: leave a valid, unexpired pair alone unless --force was passed. -checkend 0 succeeds
# while the certificate is still valid; comparing the public keys catches a cert and key that no
# longer match, which is what an interrupted earlier run leaves behind.
if [ "$FORCE" != "yes" ] && [ -s "$CERT" ] && [ -s "$KEY" ]; then
  if openssl x509 -checkend 0 -noout -in "$CERT" >/dev/null 2>&1; then
    cert_pub="$(openssl x509 -noout -pubkey -in "$CERT" 2>/dev/null | openssl sha256 2>/dev/null || true)"
    key_pub="$(openssl pkey -pubout -in "$KEY" 2>/dev/null | openssl sha256 2>/dev/null || true)"
    if [ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ]; then
      printf 'certificate for %s is present and unexpired; leaving it as is (pass --force to replace)\n' "$NAME"
      printf 'CERT_FILE=%s\n' "$NAME/fullchain.pem"
      printf 'KEY_FILE=%s\n' "$NAME/privkey.pem"
      exit 0
    fi
  fi
fi

mkdir -p "$OUT_DIR"

# RSA 2048 for the widest client compatibility. 825 days is the longest a certificate is accepted
# for since 2018, so a self-signed one dated further out is rejected early anyway.
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$KEY" -out "$CERT" \
  -days 825 \
  -subj "/CN=$NAME" \
  -addext "subjectAltName=$SAN" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1

chmod 600 "$KEY"
chmod 644 "$CERT"

printf 'wrote a self-signed certificate for %s (SAN %s), valid 825 days\n' "$NAME" "$SAN"
printf 'CERT_FILE=%s\n' "$NAME/fullchain.pem"
printf 'KEY_FILE=%s\n' "$NAME/privkey.pem"
