#!/usr/bin/env bash
# ============================================================
#  Установка «Стрижи · Водоснабжение» на чистый VPS (Debian/Ubuntu).
#  Запускать от root:
#     bash deploy/install.sh                       # только приложение, порт 8080
#     bash deploy/install.sh strizhi.example.ru    # + nginx и TLS для домена
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/ksemenhaifa/vpnbottelega.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/strizhi-water
DATA_DIR=/var/lib/strizhi-water

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root (sudo bash deploy/install.sh)"; exit 1; }

echo "==> Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 18 ]; then
  echo "==> Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

echo "==> Код в $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> Пользователь и данные"
id -u strizhi >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin strizhi
mkdir -p "$DATA_DIR"
chown -R strizhi:strizhi "$DATA_DIR"
chown -R root:root "$APP_DIR"          # код только на чтение для сервиса

echo "==> systemd"
install -m 644 "$APP_DIR/deploy/strizhi-water.service" /etc/systemd/system/strizhi-water.service
if [ -z "$DOMAIN" ]; then
  # без nginx слушаем все интерфейсы, чтобы сайт открывался по http://IP:8080
  sed -i 's/^Environment=HOST=127.0.0.1/Environment=HOST=0.0.0.0/' /etc/systemd/system/strizhi-water.service
fi
systemctl daemon-reload
systemctl enable --now strizhi-water
sleep 2
systemctl is-active --quiet strizhi-water || { journalctl -u strizhi-water -n 30 --no-pager; exit 1; }

if [ -n "$DOMAIN" ]; then
  echo "==> nginx для $DOMAIN"
  apt-get install -y -qq nginx
  grep -q 'zone=strizhi_api' /etc/nginx/nginx.conf || \
    sed -i '/^http {/a \    limit_req_zone $binary_remote_addr zone=strizhi_api:10m rate=6r/m;' /etc/nginx/nginx.conf
  sed "s/strizhi.example.ru/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/strizhi-water
  ln -sf /etc/nginx/sites-available/strizhi-water /etc/nginx/sites-enabled/strizhi-water
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx

  echo "==> TLS (Let's Encrypt)"
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || echo "    ! Сертификат не выпущен. Проверьте, что домен указывает на этот сервер (A-запись), и повторите: certbot --nginx -d $DOMAIN"

  echo; echo "Готово: https://$DOMAIN"
else
  IP=$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo; echo "Готово: http://$IP:8080"
  echo "Не забудьте открыть порт:  ufw allow 8080/tcp"
fi

echo "Логи:      journalctl -u strizhi-water -f"
echo "Обновить:  bash $APP_DIR/deploy/install.sh ${DOMAIN}"
