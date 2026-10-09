#!/bin/bash
# Sobe o Alumen do zero numa EC2 Amazon Linux 2023, sem dados (banco vazio).
#
#   cd ~/Alumen && bash deploy/bootstrap.sh [alumen-secrets.tar.gz]
#
# As credenciais (.env.local, config.json, data/service-account.json) ficam fora
# do git: ou vêm no tarball opcional, ou já foram criadas à mão no repo. O primeiro admin é criado a partir de ADMIN_BASIC_AUTH no boot.
# Usa o Node que já estiver no PATH (>= 20); sem Node, instala o 24.20.0 via nvm.
set -euo pipefail

SECRETS="${1:-}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"

echo "[1/6] Pacotes"
sudo dnf install -y nginx gcc-c++ make python3

echo "[2/6] Node"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  . "$NVM_DIR/nvm.sh"
  # Um prefix no ~/.npmrc (npm global em ~/.npm-global) faz o nvm recusar a
  # ativação e sair com erro depois do download; --delete-prefix resolve.
  nvm install 24.20.0 || true
  nvm use --delete-prefix 24.20.0
fi
NODE_BIN="$(dirname "$(command -v node)")"
echo "Node $(node -v) em $NODE_BIN"

echo "[3/6] Swap de 4 GiB"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
fi

echo "[4/6] Credenciais"
mkdir -p data
[ -n "$SECRETS" ] && tar -xzf "$SECRETS" -C "$APP"
for f in .env.local config.json data/service-account.json; do
  [ -s "$f" ] || { echo "ERRO: falta $APP/$f"; exit 1; }
done
chmod 600 .env.local config.json data/service-account.json

echo "[5/6] Dependências e build"
npm ci
npm run build

echo "[6/6] Serviço + nginx"
# O unit do repo aponta para o Node do nvm; troca pelo Node encontrado acima
# e pelo diretório onde o repo foi clonado.
sed -e "s|/home/ec2-user/.nvm/versions/node/v24.20.0/bin|$NODE_BIN|g" \
    -e "s|/home/ec2-user/Alumen|$APP|g" \
    -e "s|^User=.*|User=$(id -un)|" -e "s|^Group=.*|Group=$(id -gn)|" \
    deploy-alumen.service | sudo tee /etc/systemd/system/alumen.service >/dev/null
sudo cp deploy/nginx-strom.conf /etc/nginx/conf.d/strom.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable alumen nginx
sudo systemctl restart alumen nginx

echo "Aguardando o app subir..."
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ || true)
  case "$code" in 200|307|308) break ;; esac
  sleep 2
done
echo "http://127.0.0.1/ -> $code"
case "$code" in
  200|307|308) echo "OK. Abra http://<IP da máquina>/ no navegador. Login: ADMIN_BASIC_AUTH do .env.local." ;;
  *) echo "Falhou. Log: sudo journalctl -u alumen -n 50"; exit 1 ;;
esac
