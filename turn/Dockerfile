# coturn, configured at boot from the environment.
#
# Pinned rather than :latest — a TURN server is infrastructure, and an
# unannounced upgrade is not the kind of surprise worth having.
FROM coturn/coturn:4.6.2-alpine

USER root
RUN apk add --no-cache gettext bind-tools

COPY turnserver.conf.tmpl /etc/coturn/turnserver.conf.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 3478 STUN/TURN, 5349 TLS, 443 TLS (the one that gets through hostile
# networks), and the relay range — see README on why this range is narrow.
EXPOSE 3478/udp 3478/tcp 5349/tcp 443/tcp 49160-49200/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
