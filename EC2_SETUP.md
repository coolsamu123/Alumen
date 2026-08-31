# Alumen — Setup e operação em EC2

## Instância

```
Host público: ec2-51-20-184-90.eu-north-1.compute.amazonaws.com
IP:           51.20.184.90   (Elastic IP — não muda em stop/start)
Instance ID:  i-0b2afe2d8b50b1424
Região:       eu-north-1
Security group: launch-wizard-1
```

## Como o app roda (desde 2026-08-31)

**Serviço systemd `alumen`, build de produção.** Não use mais `./start.sh` — ele
sobe `next dev` na mesma porta 3333 e vai colidir com o serviço.

```bash
sudo systemctl status alumen      # estado
sudo systemctl restart alumen     # reiniciar
sudo journalctl -u alumen -f      # logs ao vivo
```

Por que mudou de `next dev` para produção:

| | dev | produção |
|---|---|---|
| memória residente | ~1,28 GB | ~139 MB |
| primeira resposta de `/` | 9–52 s (compila sob demanda) | ~0,26 s |

O `next dev` era o que o OOM killer derrubava. Com 139 MB o risco praticamente
desaparece.

### Ao mudar o código

O servidor de produção serve o build, não o fonte. Depois de editar:

```bash
cd /home/ec2-user/Alumen
npm run build && sudo systemctl restart alumen
```

Se o `npm run build` falhar por lint, ele **não** publica — o serviço continua
servindo o build anterior. Isso é proposital.

## O que garante que fica de pé

| Camada | Mecanismo |
|---|---|
| Boot | `systemctl enable alumen` + `nginx` — ambos `enabled` |
| Crash / OOM | `Restart=always`, `RestartSec=5` (testado com SIGKILL: volta em ~12 s) |
| Crash-loop | `StartLimitBurst=5` em 300 s — para de tentar, para um deploy quebrado ficar visível em vez de martelar |
| Pressão de memória | `NODE_OPTIONS=--max-old-space-size=1536` + 4 GiB de swap em `/etc/fstab` |
| Escolha da vítima do OOM | `OOMScoreAdjust=500` — o kernel mata o app antes de nginx/sshd, então a máquina continua acessível |
| Endereço | Elastic IP — sobrevive a stop/start |

## nginx

Porta 80 → `127.0.0.1:3333`, preservando o header `Host` (o gate de
`PUBLIC_HOSTS` depende dele). Config em `/etc/nginx/conf.d/strom.conf`; o
server block default do `nginx.conf` foi removido para não competir.

## Acesso e proteção

`.env.local` (fora do git):

```env
GEMINI_API_KEY=...
PUBLIC_HOSTS=amazonaws.com
ADMIN_BASIC_AUTH=admin:<senha>
```

O middleware (`src/middleware.ts`) exige Basic Auth para `/admin`,
`/api/admin`, `/api/drive`, `/api/goals`, uploads e POSTs caros **quando o
header Host casa com `PUBLIC_HOSTS`**. Acesso local (SSH/localhost) nunca é
desafiado.

Validado:

| Acesso | Resultado |
|---|---|
| `http://localhost/` | 200 |
| `http://localhost/admin` | 200 (local, sem senha) |
| host público `/` | 200 |
| host público `/admin` sem credencial | 401 |
| host público `/admin` com credencial | 200 |

## ⚠️ Dependência externa não resolvida

**A porta 80 precisa estar liberada no Security Group `launch-wizard-1`**
(inbound HTTP, porta 80). Isso é feito no console da AWS e não pode ser
verificado de dentro da instância. Sem essa regra, tudo acima funciona
localmente mas a URL pública não responde.

## Serviços de apoio

- `data/service-account.json` (modo 600) — Google Drive. As pastas do Drive
  precisam ser compartilhadas com
  `al-bco-e9997-talend-etl@al-bco-e9997-talend-etl-292614.iam.gserviceaccount.com`.
- Modelo LLM em `config.json`: `gemini-3.1-pro-preview`. O default do código
  (`gemini-3-pro`) não existe mais nesta conta — se o modelo sair do ar,
  `POST /api/admin/config` com `{"model": "..."}` troca sem redeploy.

## Variáveis de ajuste

| Variável | Default | Efeito |
|---|---|---|
| `STROM_LLM_DAILY_CAP` | 500 | Teto diário de chamadas ao LLM |
| `STROM_GOALS_CONCURRENCY` | 3 | Extrações de goals em paralelo — subir com a RAM em vista |
| `STROM_GOALS_MAX_CHARS` | 300000 | Texto de documentos por projeto enviado ao LLM |

## Notas

- Não há scheduler. `src/instrumentation.ts` é um no-op; o `start.sh` ainda
  imprime mensagens sobre cron que não correspondem a nada.
- Journald está em 24 MB, com 71 GB livres no disco. Sem risco de encher.
