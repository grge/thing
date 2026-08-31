#!/bin/sh
# Render the config from the environment, then exec coturn.
#
# Everything that varies between deployments is an env var; nothing secret is
# ever baked into the image.
set -eu

: "${TURN_SECRET:?TURN_SECRET must be set (see README)}"
: "${TURN_REALM:?TURN_REALM must be set, e.g. turn.example.com}"

# coturn must advertise the address peers can actually reach. In a container
# behind NAT (Fly, most clouds) the interface address is private, so the
# public one has to be supplied and mapped explicitly.
if [ -z "${TURN_EXTERNAL_IP:-}" ]; then
  echo "TURN_EXTERNAL_IP not set; discovering..." >&2
  TURN_EXTERNAL_IP="$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null || true)"
fi
[ -n "$TURN_EXTERNAL_IP" ] || { echo "could not determine external IP; set TURN_EXTERNAL_IP" >&2; exit 1; }

TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

export TURN_SECRET TURN_REALM TURN_EXTERNAL_IP TURN_MIN_PORT TURN_MAX_PORT

envsubst < /etc/coturn/turnserver.conf.tmpl > /etc/coturn/turnserver.conf

# The secret is in the rendered file; keep it off the filesystem for anyone else.
chmod 600 /etc/coturn/turnserver.conf

echo "coturn: realm=$TURN_REALM external-ip=$TURN_EXTERNAL_IP relay=$TURN_MIN_PORT-$TURN_MAX_PORT" >&2
exec turnserver -c /etc/coturn/turnserver.conf --no-cli "$@"
