# Infra & CI/CD — Alumen Portfolio Intelligence

## O que é o Alumen

**Alumen** é uma plataforma interna de inteligência de portfólio de TI desenvolvida para o processo de governança do **CDIOO (Chief Digital & Information Operations Officer) da Air Liquide**.

O sistema ingere, enriquece e visualiza o ciclo de vida completo dos projetos de TI revisados pelo comitê CDIOO. Combina dados estruturados (exportações Excel, Google Sheets) com documentos não estruturados (pastas do Google Drive) e usa **Google Gemini 2.0 Flash** para extrair insights de governança e identificar relações de impacto entre projetos em escala.

### O que o Alumen responde

- Quais projetos compartilham infraestrutura, fornecedores ou dependências tecnológicas?
- Qual é o impacto de segurança, regional ou organizacional de um projeto?
- Quais serviços GIO são afetados por um determinado projeto?
- Onde estão os riscos de bloqueio de cronograma ou disputa de recursos no portfólio?

### Pipeline de dados (3 etapas)

```
[Excel / Google Sheets]          [Google Drive]
        │                               │
        ▼                               ▼
  1. Drive Sync ──── baixa documentos (PDF, DOCX, slides) ────►  documents_cache
        │
        ▼
  2. Goals Extraction (Gemini) ── extrai 8 campos de governança ─► project_goals
     (Digital Technologies · Change Management · Security · Regional
      AI Embedded · GIO/DDS Impacts · Workload · Business Apps & CIs)
        │
        ▼
  3. Impact Analysis (Gemini) ─── identifica relações entre projetos ► projects_impact
     (tipo · direção · severidade · serviços GIO afetados · explicação)
```

### Stack

| Camada | Tecnologia |
|---|---|
| Frontend | Next.js 14, React 18, TypeScript, TailwindCSS |
| Backend | Next.js API Routes (Node.js) |
| Banco de dados | SQLite via `better-sqlite3` |
| IA | Google Gemini 2.0 Flash (extração + análise de impacto) |
| Integrações | Google Drive API, Google Sheets API |
| Infraestrutura | EC2 (eu-west-3 Paris), Nginx, PM2 |

### Views disponíveis

| View | Descrição |
|---|---|
| Impact | Lista de relações de impacto com severidade, direção e serviços GIO |
| Graph | Grafo força-dirigida: nós = projetos, arestas = impactos |
| Timeline | Projetos agrupados por mês de revisão |
| Details | Grid de cards com todos os campos extraídos |
| Goals Extractor | UI da extração de campos de governança por projeto |
| Drive Sync | Gerenciamento da integração com Google Drive e Sheets |
| Alumen | Arquitetura do pipeline + animação do fluxo de dados |

---

## Perfil de recursos do app

| Fator | Detalhe |
|---|---|
| Node heap | 3 GB (configurado no `start.sh`) |
| Swap recomendado | 4 GB |
| Banco de dados | SQLite local — sem servidor externo |
| Background jobs | Scheduler de auto-discovery (cron) + warmup de rotas |
| Modo atual | `next dev` (sem build prévio) |
| Região atual | `eu-west-3` (Paris) |

---

## Máquinas recomendadas

> Preços **on-demand Linux**, região **eu-west-3 (AWS)** / **europe-west9 Paris (GCP)**.
> Estimativas de agosto 2025 — confirme no console antes de provisionar.

### Cenário A — 1 ambiente (só prod)

| Cloud | Instância | vCPU | RAM | Disco sugerido | $/hora | $/mês |
|---|---|---|---|---|---|---|
| AWS | t3.medium | 2 | 4 GB | 30 GB gp3 | ~$0.046 | ~$34 |
| **AWS** | **t3.large ✓** | **2** | **8 GB** | **30 GB gp3** | **~$0.092** | **~$67** |
| AWS | t3.xlarge | 4 | 16 GB | 30 GB gp3 | ~$0.184 | ~$134 |
| GCP | e2-medium | 1 (shared) | 4 GB | 30 GB pd-balanced | ~$0.034 | ~$25 |
| **GCP** | **e2-standard-2 ✓** | **2** | **8 GB** | **30 GB pd-balanced** | **~$0.067** | **~$49** |
| GCP | e2-standard-4 | 4 | 16 GB | 30 GB pd-balanced | ~$0.134 | ~$98 |

`t3.medium` / `e2-medium` — marginal, só funciona com swap generoso e `STROM_WARMUP=0`. Não recomendado para uso real.

### Cenário B — 2 ambientes na mesma máquina (dev + prod)

Duas instâncias Next.js simultâneas: dev (`next dev`, ~2 GB heap) + prod (`next start`, ~1 GB).

| Cloud | Instância | vCPU | RAM | Disco sugerido | $/hora | $/mês | Observação |
|---|---|---|---|---|---|---|---|
| AWS | t3.large | 2 | 8 GB | 40 GB gp3 | ~$0.092 | ~$67 | Mínimo viável, pouco headroom |
| **AWS** | **t3.xlarge ✓** | **4** | **16 GB** | **40 GB gp3** | **~$0.184** | **~$134** | **Recomendado** |
| AWS | m6i.large | 2 | 8 GB | 40 GB gp3 | ~$0.118 | ~$86 | CPU dedicada (sem burst) |
| AWS | m6i.xlarge | 4 | 16 GB | 40 GB gp3 | ~$0.236 | ~$172 | Prod-grade sem burst |
| GCP | e2-standard-2 | 2 | 8 GB | 40 GB pd-balanced | ~$0.067 | ~$49 | Mínimo viável |
| **GCP** | **e2-standard-4 ✓** | **4** | **16 GB** | **40 GB pd-balanced** | **~$0.134** | **~$98** | **Recomendado** |
| GCP | n2-standard-2 | 2 | 8 GB | 40 GB pd-balanced | ~$0.097 | ~$71 | CPU dedicada |
| GCP | n2-standard-4 | 4 | 16 GB | 40 GB pd-balanced | ~$0.194 | ~$142 | Prod-grade |

### Economia com compromisso de 1 ano

| | t3.xlarge on-demand | t3.xlarge 1-yr reserved | e2-standard-4 on-demand | e2-standard-4 1-yr committed |
|---|---|---|---|---|
| $/mês | ~$134 | **~$86** (~36% off) | ~$98 | **~$66** (~33% off) |

### Resumo de decisão

| Situação | Máquina |
|---|---|
| 1 ambiente, orçamento mínimo | t3.large (AWS) ou e2-standard-2 (GCP) |
| 2 ambientes, uso diário real | **t3.xlarge (AWS)** ou **e2-standard-4 (GCP)** |
| Prefere GCP (mais barato) | e2-standard-4 em `europe-west9` — ~$35/mês mais barato |
| Prefere AWS (já está lá) | t3.xlarge em `eu-west-3` — mantém a região atual |

> **Disco:** SQLite + uploads + dois clones com `node_modules` chegam facilmente a 5–8 GB. 40 GB gp3/pd-balanced é confortável.

---

## Plano de implementação CI/CD

### Visão geral

```
push → branch dev  ──► GitHub Actions ──► SSH na EC2 ──► deploy.sh dev  ──► PM2 strom-dev  (porta 3334)
push → branch main ──► GitHub Actions ──► SSH na EC2 ──► deploy.sh prod ──► PM2 strom-prod (porta 3333)
                                                                                     │
                                                                                  Nginx (porta 80)
```

### Estrutura de diretórios na EC2

```
/opt/strom/
  app-dev/          ← clone do repo, branch dev
  app-prod/         ← clone do repo, branch main
  data/             ← SQLite prod  (cioo.db)
  data-dev/         ← SQLite dev   (cópia isolada)
  deploy.sh         ← script central de deploy
```

---

### Passo 1 — Preparar a EC2

```bash
# Dependências base
sudo apt update && sudo apt install -y git nginx curl

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2
sudo npm install -g pm2

# Diretórios
sudo mkdir -p /opt/strom/data /opt/strom/data-dev
sudo chown -R ubuntu:ubuntu /opt/strom

# Clonar os dois ambientes
cd /opt/strom
git clone git@github.com:coolsamu123/Igarape.git app-prod
git clone git@github.com:coolsamu123/Igarape.git app-dev

cd /opt/strom/app-prod && git checkout main  && npm install
cd /opt/strom/app-dev  && git checkout dev   && npm install

# Banco dev: copiar snapshot inicial do prod
cp /opt/strom/data/cioo.db /opt/strom/data-dev/cioo.db
```

---

### Passo 2 — Arquivos de ambiente

**`/opt/strom/app-prod/.env.local`**
```env
PORT=3333
NODE_ENV=production
DATA_DIR=/opt/strom/data
NODE_OPTIONS=--max-old-space-size=3072
STROM_AUTO_DISCOVERY=1
STROM_LLM_DAILY_CAP=500
# copie as demais variáveis do .env.local atual (GEMINI_API_KEY, etc.)
```

**`/opt/strom/app-dev/.env.local`**
```env
PORT=3334
NODE_ENV=development
DATA_DIR=/opt/strom/data-dev
NODE_OPTIONS=--max-old-space-size=2048
STROM_AUTO_DISCOVERY=0
STROM_WARMUP=0
# mesmas chaves de API do prod
```

---

### Passo 3 — PM2 ecosystem

**`/opt/strom/ecosystem.config.js`**
```js
module.exports = {
  apps: [
    {
      name: 'strom-prod',
      cwd: '/opt/strom/app-prod',
      script: 'node_modules/.bin/next',
      args: 'start',
      env: { PORT: '3333', NODE_ENV: 'production' },
      max_memory_restart: '3200M',
      restart_delay: 3000,
    },
    {
      name: 'strom-dev',
      cwd: '/opt/strom/app-dev',
      script: 'node_modules/.bin/next',
      args: 'dev -p 3334',
      env: { PORT: '3334', NODE_ENV: 'development' },
      max_memory_restart: '2500M',
      restart_delay: 3000,
    },
  ],
};
```

```bash
# Primeiro start
cd /opt/strom/app-prod && npm run build   # build inicial do prod
pm2 start /opt/strom/ecosystem.config.js
pm2 save
pm2 startup   # copie e execute o comando que ele gerar
```

---

### Passo 4 — Nginx

**`/etc/nginx/sites-available/strom`**
```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 100M;

    # prod — raiz
    location / {
        proxy_pass         http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # dev — prefixo /dev/
    location /dev/ {
        rewrite            ^/dev/(.*)$ /$1 break;
        proxy_pass         http://127.0.0.1:3334;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/strom /etc/nginx/sites-enabled/strom
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

### Passo 5 — Script de deploy

**`/opt/strom/deploy.sh`**
```bash
#!/bin/bash
set -euo pipefail

ENV="${1:-}"
if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "Uso: ./deploy.sh dev | prod"
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  DIR=/opt/strom/app-prod
  PM2=strom-prod
  BRANCH=main
  BUILD=true
else
  DIR=/opt/strom/app-dev
  PM2=strom-dev
  BRANCH=dev
  BUILD=false
fi

echo "==> Deploy $ENV ($BRANCH) em $DIR"

cd "$DIR"
git fetch origin
git reset --hard "origin/$BRANCH"
npm install --prefer-offline

if [[ "$BUILD" == "true" ]]; then
  echo "==> Build prod..."
  npm run build
fi

pm2 restart "$PM2" --update-env
echo "==> Deploy $ENV concluído."
```

```bash
chmod +x /opt/strom/deploy.sh
```

---

### Passo 6 — GitHub Actions

**`.github/workflows/deploy.yml`**
```yaml
name: Deploy

on:
  push:
    branches: [main, dev]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            ENV=$([[ "${{ github.ref_name }}" == "main" ]] && echo "prod" || echo "dev")
            /opt/strom/deploy.sh $ENV
```

---

### Passo 7 — Secrets no GitHub

No repositório `coolsamu123/Igarape`:
**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Valor |
|---|---|
| `EC2_HOST` | IP público da EC2 |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | Conteúdo da chave privada `.pem` |

Para a EC2 aceitar a conexão do Actions, adicione a chave pública correspondente em:
```bash
echo "ssh-rsa AAAA..." >> ~/.ssh/authorized_keys
```

---

### Checklist de validação

- [ ] `pm2 list` mostra `strom-prod` e `strom-dev` com status `online`
- [ ] `curl localhost:3333/api/projects` retorna 200
- [ ] `curl localhost:3334/api/projects` retorna 200
- [ ] `curl http://<IP>/` abre o prod
- [ ] `curl http://<IP>/dev/` abre o dev
- [ ] Push na branch `dev` → Actions dispara → `strom-dev` reinicia
- [ ] Push na branch `main` → Actions dispara → build + `strom-prod` reinicia
- [ ] Após reboot da EC2: `pm2 list` mostra ambos `online` (via `pm2 startup`)
