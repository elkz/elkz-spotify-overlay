#!/usr/bin/env bash
# One-time setup on the VPS: writes .env, installs the service and the nginx site, gets HTTPS.
# Run from inside the project folder:   bash deploy/setup.sh
# Safe to run again later (e.g. to change the domain or Spotify keys).
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
APP_USER="$(whoami)"
say() { printf '\n\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }

# ---------- Node ----------
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "Node isn't installed. Install Node 18 or newer first (see the README), then run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR is too old; this needs 18 or newer."
say "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

# ---------- answers ----------
old() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
ask() {  # ask "Question" DEFAULT -> prints answer
  local q="$1" def="${2:-}" a
  if [ -n "$def" ]; then read -rp "$q [$def]: " a; echo "${a:-$def}"; else read -rp "$q: " a; echo "$a"; fi
}

DOMAIN_OLD="$(old PUBLIC_URL | sed -E 's#^https?://##')"
DOMAIN="$(ask 'Domain for the overlay, e.g. music.notelkz.net' "$DOMAIN_OLD")"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
[ -n "$DOMAIN" ] || die "A domain is needed."

CID="$(ask 'Spotify Client ID' "$(old SPOTIFY_CLIENT_ID)")"
[ -n "$CID" ] || die "The Client ID is needed (Spotify developer dashboard > your app > Settings)."

SECRET_OLD="$(old SPOTIFY_CLIENT_SECRET)"
if [ -n "$SECRET_OLD" ]; then read -rsp "Spotify Client secret (press Enter to keep the current one): " SECRET; echo
else read -rsp "Spotify Client secret (typing is hidden): " SECRET; echo; fi
SECRET="${SECRET:-$SECRET_OLD}"
[ -n "$SECRET" ] || die "The Client secret is needed."

PORT_OLD="$(old PORT)"; PORT="$(ask 'Port to run on (only change it if 8787 is already used)' "${PORT_OLD:-8787}")"
PASS="$(old SETUP_PASSWORD)"
[ -n "$PASS" ] || PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"

# ---------- .env ----------
umask 077
cat > .env <<EOF
SPOTIFY_CLIENT_ID=$CID
SPOTIFY_CLIENT_SECRET=$SECRET
PUBLIC_URL=https://$DOMAIN
SETUP_PASSWORD=$PASS
HOST=127.0.0.1
PORT=$PORT
POLL_MS=2500
EOF
chmod 600 .env
umask 022
say "Wrote .env"

# ---------- service ----------
sudo tee /etc/systemd/system/elkz-spotify.service > /dev/null <<EOF
[Unit]
Description=elkz Spotify now playing overlay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable elkz-spotify > /dev/null 2>&1 || true
sudo systemctl restart elkz-spotify
sleep 1
if systemctl is-active --quiet elkz-spotify; then say "Service running (elkz-spotify)"; else
  sudo journalctl -u elkz-spotify -n 20 --no-pager; die "The service didn't start; the log above says why."; fi

# ---------- nginx + https ----------
if command -v nginx > /dev/null; then
  sed -e "s/music.example.com/$DOMAIN/g" -e "s/127.0.0.1:8787/127.0.0.1:$PORT/g" deploy/nginx.conf | sudo tee /etc/nginx/sites-available/elkz-spotify > /dev/null
  sudo ln -sf /etc/nginx/sites-available/elkz-spotify /etc/nginx/sites-enabled/elkz-spotify
  sudo nginx -t && sudo systemctl reload nginx
  say "nginx is serving $DOMAIN"
  if command -v certbot > /dev/null; then
    if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
      say "Getting an HTTPS certificate (the domain's DNS must already point at this server)"
      sudo certbot --nginx -d "$DOMAIN" --redirect || say "certbot didn't finish. Check the DNS record, then run: sudo certbot --nginx -d $DOMAIN"
    else
      # the nginx file was just rewritten, so put the existing certificate back into it
      sudo certbot --nginx -d "$DOMAIN" --redirect --reinstall --non-interactive > /dev/null 2>&1 \
        && say "HTTPS is on (existing certificate)" \
        || say "Couldn't re-add HTTPS automatically. Run: sudo certbot --nginx -d $DOMAIN"
    fi
  else
    say "certbot isn't installed. Install it:  sudo apt install certbot python3-certbot-nginx  then run: sudo certbot --nginx -d $DOMAIN"
  fi
else
  say "nginx isn't installed. Install it (sudo apt install nginx) and run this script again."
fi

# ---------- done ----------
cat <<EOF

========================================================================
 Done.

 1. In the Spotify developer dashboard, the Redirect URI must be exactly:
      https://$DOMAIN/callback

 2. Sign in to Spotify (once):  https://$DOMAIN/login
    Setup password:             $PASS
    (it's also in $APP_DIR/.env)

 3. Pick the look and copy the OBS URL:  https://$DOMAIN/setup

 Logs:     sudo journalctl -u elkz-spotify -f
 Restart:  sudo systemctl restart elkz-spotify
========================================================================
EOF
