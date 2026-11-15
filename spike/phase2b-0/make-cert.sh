#!/bin/sh
# Phase 2B-0 spike: make a SELF-SIGNED certificate for the https/wss variants (L3, L4).
# Usage: ./make-cert.sh <laptop-LAN-IP> [output-dir]      (default output dir: ./certs)
# Then:  CERT_FILE=certs/cert.pem KEY_FILE=certs/key.pem node server.mjs
#
# The certificate is NOT trusted by the phone. Open https://<ip>:8443/ping once in
# Chrome on the phone and accept the warning before the wss:// test.
# Do NOT commit key.pem. The certificate expires after 14 days.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <laptop-LAN-IP> [output-dir]" >&2
  exit 1
fi

IP="$1"
OUT="${2:-certs}"

case "$IP" in
  *[!0-9.]*) echo "error: '$IP' is not an IPv4 address" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
openssl req -x509 -newkey rsa:2048 -nodes -days 14 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" 2>/dev/null

chmod 600 "$OUT/key.pem"
echo "wrote $OUT/cert.pem and $OUT/key.pem for IP:$IP (self-signed, 14 days)"
