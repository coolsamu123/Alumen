# Plano: Gestão de Usuários — roles e escopo por projeto/DDS

Dois papéis: **admin** (tudo) e **basic** (vê apenas os projetos que lhe forem
atribuídos, individualmente ou por DDS). Admin e Drive Sync são exclusivos do
admin. Ações de execução (Run Analysis, Erase, Sync, Run All) ficam desativadas
para o basic.

Auditoria feita sobre `middleware.ts`, `public-host.ts`, `layout.tsx`,
`page.tsx`, `ProjectContext.tsx`, `Header.tsx`, `ImpactView.tsx`,
`GoalsView.tsx`, `DriveView.tsx`, `db.ts` e as 34 rotas em `src/app/api/`
(2026-09-09).

---

## 0. Status

| Fase | Estado | Quando |
|---|---|---|
| 1 — Identidade | ✅ **done — implantado em produção** | 2026-09-09 |
| 2 — Escopo | ✅ **done — implantado em produção** | 2026-09-09 |
| 3 — Gestão | ✅ **done — implantado em produção** | 2026-09-09 |
| 4 — Acabamento | ⬜ não iniciada | — |
| 5 — Matar modo público | ⬜ não iniciada (deliberadamente por último, §7.1) | — |
| 6 — Okta | ⬜ bloqueada pela demanda MMS (§8) | — |

Ver §6 para o detalhamento marcado item a item de cada fase.

---

## 1. O que existe hoje

Já há um esqueleto de dois níveis — mas ele **não é um sistema de usuários**:

| Peça | Hoje | Limitação |
|---|---|---|
| Autenticação | Basic Auth, uma senha compartilhada (`ADMIN_BASIC_AUTH`) em `middleware.ts:105` | Não identifica *quem* entrou. Sem logout, sem revogação. |
| Gate | Só dispara quando `Host` casa com `PUBLIC_HOSTS` (`public-host.ts:9`) | Acesso local/SSH nunca é desafiado. |
| Estado na UI | `isPublic` booleano: `layout.tsx:40` → `ProjectContext.tsx:55` → views | Binário. Não comporta "vê parte do portfólio". |
| Proteção real | `PROTECTED_PREFIXES` em `middleware.ts:26-43` | Protege escrita. **Toda leitura de portfólio é aberta.** |

O ponto crítico: `isPublic` hoje só **esconde botão** (`ImpactView.tsx:165`,
`page.tsx:50`, `Header.tsx:71`). Isso é suficiente enquanto o único eixo é
"pode escrever ou não", porque a escrita está barrada no middleware. **Deixa de
ser suficiente no minuto em que existir "vê só parte dos projetos"** — aí a
regra passa a valer sobre *dados*, e dado escondido no cliente continua indo
pela rede.

---

## 2. As quatro armadilhas

Esta é a parte que decide se o resultado é seguro ou só parece seguro.

### 2.1 Escopo aqui é filtro de UI, não fronteira de segurança

**Decisão de produto (2026-09-09):** restringir visibilidade é exceção rara.
Praticamente todo usuário verá o portfólio inteiro; a funcionalidade existe para
uns poucos casos pontuais. Todo mundo com conta é da equipe interna de
governança. Logo, o modelo de ameaça **não** é "usuário mal-intencionado
exfiltrando pelo DevTools" — é "não poluir a tela de quem não precisa daquilo".

Isso é deliberado e muda a engenharia: o corte não precisa ser à prova de
inspeção de rede. Basta ser consistente na experiência.

Na prática o filtro vive no ponto de entrada principal — `GET /api/projects`
(`api/projects/route.ts:7`, que delega para `fetchProjectSummariesForViews()`).
`filtered`, `filteredWithSignal` e `links` (`ProjectContext.tsx:123-190`) são
todos derivados do que o servidor mandou, então **cortar na entrada já propaga
para Graph, Matrix, Timeline e Details sem tocar em nenhuma view**. Só o
dropdown de DDS do Toolbar precisa passar a listar apenas os DDS visíveis.

O bloco `stats` em `api/projects/route.ts:25-32` deve ser calculado depois do
filtro — não por sigilo, mas porque um contador que não bate com a lista na tela
é bug visível.

Se um dia o requisito virar fronteira de verdade (usuário externo, auditor,
fornecedor), a conversa muda: aí é filtrar todas as ~10 rotas de leitura, e vale
o teste da §6. Hoje não é o caso.

### 2.2 O middleware roda no Edge — sem SQLite e sem `node:crypto`

O código já tropeçou nisso: `middleware.ts:77` implementa comparação
constant-time à mão porque "Edge runtime has no node:crypto". Pelo mesmo motivo
o middleware **não consegue** abrir o SQLite (`better-sqlite3` é nativo, Node
puro) para validar sessão.

Solução em duas camadas:

- **Middleware (Edge, barato):** cookie assinado e *stateless*. Payload
  `{uid, role, tv, exp}` + HMAC-SHA256 via `crypto.subtle` (existe no Edge).
  Valida assinatura, expiração e faz o gate grosso de rota (`/admin` e
  `/api/admin` exigem `role=admin`).
- **Route handlers (Node, autoritativo):** `getSession()` relê o usuário do
  banco — `is_active`, `role` atual e escopos. É aqui que o escopo é aplicado.

O middleware nunca é a fonte da verdade sobre escopo; ele só evita que
requisição sem cookie válido chegue longe.

**Revogação:** cookie stateless não morre quando você desativa um usuário. Por
isso o campo `token_version` (`tv`) no payload: ao desativar, trocar senha ou
mudar role, incrementa `users.token_version` e todo cookie emitido antes vira
inválido na primeira checagem do handler.

### 2.3 Arestas órfãs — agora é coerência de tela, não vazamento

Impacto é uma aresta entre **dois** projetos. Se o usuário vê A mas não B, e
existe `A → B`, a aresta aponta para um nó que não está na lista dele.

Com o modelo de segurança relaxado (§2.1), isso deixa de ser vazamento — o
`explanation` citar B pelo nome não é mais problema. Mas continua sendo **bug de
render**: o Graph desenha nó pendurado sem dado, a Matrix ganha coluna sem
linha, e a Universe de A mostra vizinho fantasma.

**Regra mantida, motivo novo:** um impacto só entra se ambas as pontas
estiverem no conjunto visível. Não por sigilo — para a tela não quebrar.

Exceção obrigatória: o nó virtual `GIO_SERVICES` (tratado à parte em
`ProjectContext.tsx:161,169-174`) é agregador, não é projeto — sempre visível.

Pelo mesmo motivo relaxado, `EvidencePanel.tsx`, `impact-narrative.ts` e
`deep-dive-engine.ts` **não precisam de tratamento**. São alcançados só a partir
de um projeto já aberto, e o texto que eles exibem não é mais material sensível
sob este modelo.

### 2.4 Bootstrap e lockout

Se o login virar obrigatório sem semear um admin, o deploy tranca todo mundo do
lado de fora. Precisa de:

- Script `scripts/create-admin.mjs` (roda via SSH na EC2) — sempre disponível
  como break-glass.
- Seed automático no primeiro boot a partir do `ADMIN_BASIC_AUTH` que já existe
  no `.env.local`, para a migração não exigir intervenção.
- Decidir o que acontece com acesso local: hoje `localhost` nunca é desafiado
  (`middleware.ts:107`). Manter esse bypass é conveniente para operação por SSH,
  mas significa que quem tem shell na máquina é admin de fato — o que já é
  verdade hoje, já que o banco está no disco.

---

## 3. Modelo de dados

Seguindo o padrão de `db.ts:31` (`CREATE TABLE IF NOT EXISTS` no `db.exec`
inicial, sem ferramenta de migração):

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,   -- email CORPORATIVO, minúsculo (§8.1)
  name          TEXT NOT NULL DEFAULT '',
  auth_provider TEXT NOT NULL DEFAULT 'local'
                CHECK (auth_provider IN ('local','okta')),
  password_hash TEXT,                    -- scrypt; NULL quando provider='okta'
  role          TEXT NOT NULL CHECK (role IN ('admin','basic')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Lista de EXCEÇÃO. Usuário sem linha aqui vê o portfólio inteiro.
-- Admin ignora esta tabela.
CREATE TABLE IF NOT EXISTS user_scopes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('dds','project')),
  scope_value TEXT NOT NULL,            -- 'AMEI' | 'PRJ0018698'
  UNIQUE (user_id, scope_type, scope_value)
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user ON user_scopes(user_id);
```

**Semântica do escopo — restrição é opt-in:**

- Usuário **sem nenhuma linha** em `user_scopes` vê o portfólio inteiro. É o
  caso normal e o default de quem acabou de ser criado.
- Usuário **com linhas** vê apenas a união de (projetos cujo `dds` está entre os
  grants) com (projetos concedidos individualmente).

O default é "irrestrito" justamente porque restringir é a exceção (§2.1).
Ninguém é trancado fora por esquecimento de configuração — que seria o modo de
falha mais provável e o mais chato de suportar.

Grant por DDS é dinâmico: projeto novo naquele DDS aparece sozinho, sem precisar
reatribuir. Precisa estar claro na tela para quem administra.

`scrypt` é do stdlib do Node — evita adicionar bcrypt/argon2 e roda nos route
handlers (Node), nunca no middleware.

---

## 4. Onde enforçar — inventário real

### 4.1 Leitura (filtrar por escopo)

Sob o modelo de §2.1, são **dois** pontos, não dez:

| Rota | Ação |
|---|---|
| `GET /api/projects` | filtrar a lista + recalcular `stats` pós-filtro |
| `GET /api/impact` | regra das duas pontas (§2.3) |

O resto (`universe`, `evidence`, `deep-dive`, `planning`, `goals`,
`strom/stats`, `services`) fica como está. São alcançados a partir de um projeto
já visível na tela, e sob este modelo não justificam o trabalho.

Ponto de estrangulamento: `src/lib/access.ts` com
`getVisibleProjectIds(session): Set<string> | 'ALL'`. `'ALL'` é o caminho comum
e sai por um early-return — o custo em quem não tem restrição é zero.
`fetchProjectSummariesForViews()` (`impact-engine.ts`) recebe o filtro, já que
`/api/projects` delega para ela.

Vale receber a sessão como **argumento obrigatório** dessa função em vez de ler
de um contexto global: quem esquecer não compila. Custa nada e é a diferença
entre erro de tipo e erro silencioso.

### 4.2 Execução (admin-only, 403 no servidor)

Levantamento dos POST/DELETE disparados pela UI:

| Origem | Endpoint |
|---|---|
| `ImpactView.tsx:44,64,83` | `/api/impact` (start, erase, preview) |
| `GoalsView.tsx:176,196` | `/api/goals` (run all, run single) |
| `DriveView.tsx:145,368` | `/api/projects/upload`, `/api/drive/sync-all` (POST e DELETE) |
| `usePlanAllState.ts:65` | `/api/impact/project/planning/run-all` (POST e DELETE) |
| `ProjectPlanningPanel.tsx:105` | `/api/impact/project/planning` |
| `EvidencePanel.tsx:337` | `/api/impact/project/evidence` |
| `Sidebar.tsx:41,61` | `/api/analyze` |
| `StromArchitecture/stages.ts:272,414,520,592` | pipeline runners |
| `admin/page.tsx:69,112,153,191` | `/api/admin/*` |

O `PROTECTED_BY_METHOD` em `middleware.ts:39-43` já cobre a maior parte por
prefixo+método. Ele passa a checar `role=admin` em vez de "tem Basic Auth".

### 4.3 Navegação

`Header.tsx:6-14` — `NAV_ITEMS` ganha `adminOnly: true` em `goals` e `drive`.
`page.tsx:24` — `PUBLIC_VIEWS` vira `BASIC_VIEWS`
(`impact`, `graph`, `timeline`, `detail`, `universe`, `strom`).
`layout.tsx:47` — `ProjectProvider` recebe `session` no lugar de `isPublic`.

---

## 5. UI

### 5.1 Área de gestão (`/admin/users`)

Segue o padrão de `admin/page.tsx` e `admin/catalog/page.tsx` que já existem.

- Lista: nome, email, role, nº de projetos visíveis, último login, ativo.
- Criar usuário: email, nome, role, senha inicial.
- Editar escopo: dois blocos — **DDS** (checkboxes, lista vinda dos DDS reais
  do banco) e **Projetos avulsos** (busca + multi-seleção). Mostrar em tempo
  real "este usuário verá N projetos" — o admin precisa enxergar o efeito do
  grant antes de salvar.
- Ações: resetar senha, desativar, excluir (ambos incrementam `token_version`).

### 5.2 Botões desativados, não escondidos

Você pediu **desativados** — é a escolha certa: o basic entende que a função
existe e que falta permissão, em vez de achar que o produto não faz aquilo.
Isso inverte o padrão atual, que **esconde** (`ImpactView.tsx:165`).

Padrão: `disabled` + `title="Requer perfil administrador"` + opacidade. Um
componente `<AdminOnly>` (ou hook `useCanRun()`) evita espalhar `role === 'admin'`
por dez arquivos.

O `disabled` é cosmético — o 403 do servidor é a proteção real. Os dois andam
juntos, nunca um sem o outro.

---

## 6. Fases

Cada fase deixa o sistema íntegro. Nada de estado intermediário quebrado.

**Fase 1 — Identidade. ✅ done (2026-09-09), não implantada.**

- [x] Tabela `users` (`db.ts`) — schema conforme §3, sem `user_scopes` ainda (Fase 2)
- [x] Hash de senha — scrypt, `src/lib/password.ts`
- [x] Cookie de sessão assinado, verificável no Edge e no Node — `src/lib/session.ts`
- [x] `getSession()` autoritativo (relê `is_active`/`token_version` do banco) — `src/lib/auth.ts`
- [x] `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- [x] Página `/login`
- [x] Seed automático do primeiro admin a partir de `ADMIN_BASIC_AUTH` — `seedInitialAdmin()` em `db.ts`
- [x] Break-glass — `scripts/create-admin.mjs` (upsert por email, roda via SSH)
- [x] `middleware.ts` reescrito: Basic Auth → sessão; gate de role (`admin`) nos
      `PROTECTED_PREFIXES`/`PROTECTED_BY_METHOD` existentes; bypass local
      preservado (§2.4, ainda em aberto para decidir depois)
- [x] `npm run build` limpo (typecheck + lint)
- [x] Testado manualmente contra host externo simulado (`Host: *.amazonaws.com`):
      redirect para `/login` sem sessão, 401 em API sem sessão, 403 com sessão
      não-admin, login com senha errada rejeitado, login correto libera
      `/admin`, `/api/auth/me` retorna o usuário, logout revoga o acesso

*Ainda sem escopo:* todo autenticado vê o portfólio inteiro; muda só quem entra
e o que Admin/Drive Sync exigem. Isso é intencional (linha 269).

**Implantado em produção em 2026-09-09 15:37 UTC.** `npm run build &&
systemctl restart alumen` na EC2. Validado pós-restart contra o host real
(`ec2-51-20-184-90...amazonaws.com`, não só localhost): `/admin` externo sem
sessão redireciona para `/login`; `/api/admin/config` externo sem sessão dá 401
JSON; leitura pública (`/`, `/api/projects`) continua sem exigir login; sem
erro no `journalctl`; os 66 projetos e os agregados de `stats` batem com antes
do restart — nada de dado perdido.

O admin seedado (`email='admin'`, vindo do `ADMIN_BASIC_AUTH`) foi renomeado
para `samuel.ramos@airliquide.com` **mantendo a mesma senha** (update direto
de `email`, sem tocar `password_hash`) — resolve o gap do §8.1 sem exigir nova
senha. Um segundo usuário de teste criado durante a verificação
(`test.admin@airliquide.com`) foi removido antes do deploy.

**Pendência que sobrou:**

1. **UI ainda não fala com sessão.** `ProjectContext`/`Header`/`layout.tsx`
   continuam lendo `isPublic` via `isAnonymousExternal` (Basic-Auth-shaped, só
   que agora alimentado por sessão) — funciona, mas não há indicação visual de
   "logado como fulano" nem botão de logout na UI ainda. Isso é natural do
   corte de fase: a Fase 3 é quem constrói a tela de gestão; um indicador
   simples de sessão pode entrar ali ou antes, a seu critério.

**Fase 2 — Escopo. ✅ done (2026-09-09), implantada.**

- [x] Tabela `user_scopes` (`db.ts`) — exceção, `ON DELETE CASCADE` (FKs já
      ligadas via `PRAGMA foreign_keys = ON`)
- [x] `src/lib/access.ts` — `getVisibleProjectIds(session)`, retorna `'ALL'`
      no caso comum (early return); resolve grants de DDS dinamicamente contra
      `projects` a cada leitura
- [x] `GET /api/projects` — filtra a lista, `stats` recalculado pós-filtro
- [x] `GET /api/impact` — regra das duas pontas (`isImpactEndpointVisible`),
      aplicada também em `rawTotal` (não só em `total`/`impacts`), com exceção
      pro nó virtual `GIO_SERVICES`
- [x] Dropdown de DDS do Toolbar — **nenhuma mudança necessária**; já deriva
      de `projects` (contexto), que vem filtrado do servidor
- [x] `npm run build` limpo
- [x] Testado ponta a ponta contra host externo simulado com um usuário basic
      real, grant `dds=GIO`: sem login → 66 projetos/12 DDS; com o grant → 13
      projetos, só DDS='GIO'; impactos caíram de 199 para 29 (13 deles via
      `GIO_SERVICES`, confirmando a exceção); `rawTotal` também consistente
      (426 → 87). Usuário e grant de teste removidos do banco antes do deploy.
- [x] Implantado — `npm run build && systemctl restart alumen`, validado pós-
      restart (66 projetos, leitura pública externa continua sem exigir login)

**Fase 3 — Gestão. ✅ done (2026-09-09), implantada.**

- [x] `GET/POST /api/admin/users` — listagem (com `visibleCount` já calculado)
      e criação; `password_hash` nunca sai na resposta
- [x] `PATCH/DELETE /api/admin/users/[id]` — trocar role, ativar/desativar,
      resetar senha, remover; todas bumpam `token_version` (revogação
      imediata de sessão)
- [x] `PUT /api/admin/users/[id]/scopes` — substitui o conjunto de escopo
      inteiro, retorna `visibleCount` atualizado
- [x] Guard do último admin (`wouldRemoveLastAdmin`) — bloqueia rebaixar,
      desativar ou remover o único admin ativo restante
- [x] Tela `/admin/users` — listar, criar, trocar role, (des)ativar, resetar
      senha, remover, e um editor de escopo por usuário (checkboxes de DDS +
      busca de projeto avulso) com **prévia calculada no cliente** (sem
      round-trip) a partir da lista de projetos já carregada
- [x] Link a partir de `/admin` (card "User Management", mesmo padrão visual
      do card "Target Catalog")
- [x] **Bug pego e corrigido antes de implantar**: a resolução de escopo por
      DDS batia direto na tabela `projects` crua (uma linha por revisão
      histórica) — um projeto cujo DDS mudou entre revisões contava pelo DDS
      *antigo*, inflando a contagem (28 em vez de 13 para GIO no teste). Corrigido
      reaproveitando `fetchProjectSummariesForViews()` — a mesma fonte que
      `/api/projects` já usa, que resolve "DDS atual" como o da revisão mais
      recente (`impact-engine.ts`, `latestByReview`).
- [x] `npm run build` limpo
- [x] Testado ponta a ponta num servidor temporário antes de implantar: 401 sem
      sessão, criação de usuário basic, grant de escopo DDS=GIO →
      `visibleCount: 13` (confirmado também pelo próprio login do usuário
      testado), desativar → login falha, resetar senha → sessão antiga é
      revogada na hora (`/api/auth/me` volta `null`), remover → sucesso. O
      guard do último admin foi validado à parte, numa base SQLite descartável
      em memória (4 cenários), para não arriscar as contas admin reais.
      Usuário e escopo de teste removidos do banco antes do deploy.
- [x] Implantado — `npm run build && systemctl restart alumen`, validado
      pós-restart (66 projetos intactos, `/admin/users` externo sem sessão
      redireciona para `/login`)

**Fase 4 — Acabamento.** Botões desativados + 403 correspondente, `user_id` em
`llm_calls` / `impact_runs` / `goals_runs` (atribuição de custo por usuário,
reaproveitando `STROM_LLM_DAILY_CAP` como teto por usuário), e tela de sessões
ativas.

**Fase 5 — Matar o modo público.** Remover `PUBLIC_VIEWS` (`page.tsx:24`),
`isAnonymousExternal` e o gate por `Host` do `public-host.ts`. Login passa a ser
obrigatório em tudo. Só depois das fases 1-4 estarem de pé, com um admin válido
testado — é o passo sem volta.

**Fase 6 — Okta (quando a demanda MMS sair).** Rota ACS + biblioteca SAML,
`auth_provider='okta'` nas contas, e a rota de login local vira fallback de
break-glass ou some. Ver §8 — se as fases 1-5 seguirem o desenho de lá, esta
fase não toca em nada além da autenticação.

**Trilho paralelo — HTTPS.** Não é fase, é dependência de infra com prazo de
espera: DNS + certificado + nginx 443 (§8.4). Bloqueia a Fase 6 e não depende de
nenhuma outra. Começar cedo.

---

## 7. Decisões tomadas (2026-09-09)

1. **Modo público anônimo morre — mas por último.** Só depois de todo o resto
   funcionando, como Fase 5. Sequência certa: enquanto o modo público existe há
   uma rota de escape caso o login quebre. Efeito colateral a aceitar: enquanto
   ele estiver de pé, o escopo não é testável de verdade, porque sempre há um
   caminho não autenticado.

2. **Login local**, com o modelo já preparado para o Okta (§8).

3. **Impacto cruzando a fronteira: esconder**, por coerência de render (§2.3).

4. **Basic vê a aba Alumen (ArchFlow).** É documentação de arquitetura, sem dado
   de projeto.

5. **Admin cria usuários** pela tela. Sem convite por email — não há SMTP e,
   dado o §8, não vale construir.

6. **Provisionamento JIT no Okta.** Quem o Okta autenticar e não tiver linha em
   `users` é criado na hora como `basic`. Sem cadastro prévio, sem fila de
   aprovação. **Mas role de admin só é concedida por um admin, dentro do
   Alumen** — nunca vem do IdP. Detalhes em §8.5.

---

## 8. Caminho para o SSO Okta

Air Liquide usa **Okta** como IdP, SAML 2.0 como protocolo principal, e o
**email corporativo como identificador**. Integrar exige processo de governança
(registro no ServiceNow/CMDB → demanda MMS → survey do conector → aprovação do
GIO → troca de metadata → testes), com prazo fora do seu controle.

Por isso: **login local agora, mas desenhado para o Okta ser aditivo.** Três
decisões de agora que decidem se a migração é barata ou é reescrita.

### 8.1 Email é a chave desde o dia 1

O Okta vai entregar o email corporativo como identidade. Se as contas locais
forem criadas **com o email corporativo real** (`nome.sobrenome@airliquide.com`,
normalizado em minúsculas), então no dia da virada a asserção SAML casa com a
linha que já existe — e o usuário mantém role, escopo e histórico. A migração
de dados vira zero.

Se as contas forem criadas com apelido, email pessoal ou usuário curto, alguém
vai ter que reconciliar isso à mão depois. É o erro barato de evitar agora e
caro de corrigir depois.

`users.email UNIQUE` (§3) já está certo. O que falta é **disciplina de cadastro**
— e vale a tela de criação recusar o que não for domínio corporativo.

### 8.2 Credencial separada da identidade

```sql
-- em users:
auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','okta')),
password_hash TEXT                     -- NULL quando o usuário é 'okta'
```

`users` continua sendo a tabela de identidade e autorização (role, escopo,
`token_version`). A senha vira um detalhe destacável. Ligar o Okta para um
usuário é `UPDATE users SET auth_provider='okta', password_hash=NULL`.

### 8.3 Sessão agnóstica ao provedor

Esta é a que paga a conta. O cookie assinado da §2.2 não sabe **como** a pessoa
provou quem é — só carrega `{uid, role, tv, exp}`.

Se a rota de login for a **única** coisa no sistema que conhece senha, então
adicionar o Okta depois é puramente aditivo: uma rota ACS nova recebe a asserção
SAML, valida, acha o usuário por email e emite **o mesmo cookie**. Middleware,
`getSession()`, escopo, gates de role — nada disso é tocado.

Regra prática: nenhum código fora de `/api/auth/login` pode mencionar senha.

### 8.4 Bloqueio de infraestrutura: HTTPS

O SAML faz POST da asserção para uma **ACS URL**, e o Okta exige HTTPS. Hoje o
Alumen roda em `http://51.20.184.90/` — IP puro, porta 80, sem TLS
(`EC2_SETUP.md`). **Isso bloqueia o SSO**, e independe de código.

Precisa, com antecedência: nome DNS próprio, certificado (Let's Encrypt resolve),
nginx em 443. Vale começar cedo — é o item com maior prazo de espera e o único
que não dá para fazer no último dia.

O survey também pede **ambiente** (Sandbox / Pré-prod / Produção). Hoje existe um
só (o `INFRA_CICD.md` desenha dev+prod, mas o que está de pé é um único serviço
systemd). Convém saber se o GIO vai exigir um conector de teste separado antes de
liberar produção.

### 8.5 Provisionamento JIT e a linha que separa IdP de autorização

**Regra:** o Okta responde *quem é você*. O Alumen responde *o que você pode*.
Essas duas perguntas nunca se misturam.

Na prática, a rota ACS faz:

```
asserção SAML válida
  → acha users WHERE email = <email da asserção>
      achou      → emite cookie com a role que está no banco
      não achou  → INSERT role='basic', auth_provider='okta'  → emite cookie
```

Três guardas que precisam estar no código, não só na cabeça:

**1. `role` é literal na criação JIT, nunca lida da asserção.** Por mais
conveniente que pareça mapear um grupo Okta para admin: quem administra grupo
no Okta é o time do GIO, não você. Ligar role a um claim SAML entrega a lista de
admins do Alumen para fora. A role mora no banco local e só muda pela tela de
admin.

**2. JIT é exclusivo do caminho Okta.** No login local (Fases 1-5) não existe
auto-criação — seria cadastro aberto. JIT só é seguro porque alguém já
autenticou a pessoa antes. Isso significa que a rota de login local e a rota ACS
têm regras diferentes de "usuário desconhecido": uma recusa, a outra cria.

**3. O último admin não pode se rebaixar nem se desativar.** Guarda trivial na
tela de admin (`COUNT(*) WHERE role='admin' AND is_active=1 > 1`), evita o
lockout mais banal que existe.

### 8.6 O risco da virada: email que não casa

Com JIT ligado, um email que não bate **falha silenciosamente para o lado
errado**. Se o admin local hoje for `admin@localhost` e o Okta mandar
`samuel.ramos@airliquide.com`, o sistema não dá erro: ele cria um usuário basic
novinho, e a instância fica **sem nenhum admin acessível pela web**.

Sem JIT isso daria "usuário não encontrado" e você investigaria. Com JIT, parece
que funcionou.

Mitigação, as três:

- Criar as contas locais já com o email corporativo real (§8.1).
- Antes de ligar a Fase 6, rodar uma verificação: toda linha com `role='admin'`
  tem email de domínio corporativo?
- Manter `scripts/create-admin.mjs` (§2.4) para sempre. É o break-glass por SSH,
  e é o que salva exatamente este cenário.

### 8.7 Quem entra, afinal

"Todo mundo com Okta" na prática é "todo mundo que o GIO atribuir ao app Alumen
no Okta" — a atribuição do aplicativo é o portão real, e ele fica do lado deles,
não no seu código. É isso que torna o JIT seguro: você não está abrindo para a
Air Liquide inteira, está delegando a lista de acesso para o Okta.

Isso é o que responde o survey (§8 abertura): autorização por atribuição de app
no Okta, provisionamento JIT, papéis geridos dentro da aplicação.

Vale confirmar com o GIO **qual grupo** será atribuído ao app — é a diferença
entre a equipe de governança CDIOO e alguns milhares de pessoas.

Sobre custo de LLM: usuário basic não dispara análise (botões desativados + 403,
Fase 4), então JIT não abre exposição a gasto de Gemini. O teto de
`STROM_LLM_DAILY_CAP` continua valendo só para quem pode executar.

### 8.8 Subinvestir deliberadamente na camada de senha

A camada de credencial tem **data de validade conhecida**. Então: admin define a
senha inicial, usuário troca, fim. Sem fluxo de recuperação por email, sem token
de reset, sem tela de política de senha, sem 2FA local — o Okta traz tudo isso
pronto, e o Okta Verify já é o segundo fator.

O que sobrevive à virada: `users`, `user_scopes`, sessão, middleware, `access.ts`,
telas de admin, botões desativados. O que é descartável: a tela de login e o
hash. Manter a parte descartável pequena é a decisão de engenharia aqui.

---

## 9. Controle de execução — qual modelo em cada parte

Critério, em ordem de peso: **o erro é barulhento ou silencioso?** Depois: existe
molde no próprio repo para copiar? A tarefa exige manter muitos arquivos
coerentes ao mesmo tempo? É desenho novo ou aplicação mecânica de desenho já
decidido?

Duas verificações que sustentam a tabela (2026-09-09):

- `tsconfig.json:8` tem `"strict": true`, e `npm run build` roda typecheck +
  lint. Pelo `EC2_SETUP.md`, build quebrado não publica. **O TypeScript é rede de
  proteção real** — boa parte dos erros possíveis aqui é barulhenta.
- O modelo de segurança relaxado (§2.1) eliminou a única classe de falha
  silenciosa que existia neste plano (vazamento por rota esquecida).

| Parte | Modelo | Por quê |
|---|---|---|
| **Fase 1** — tabelas, scrypt, login, logout, seed, `create-admin.mjs` | Sonnet | Molde no repo (`db.ts:31`), stdlib, falha barulhenta |
| **Fase 1** — cookie HMAC no Edge + reescrita do `middleware.ts` | Sonnet + revisão | Território documentado e falha barulhenta, **mas** o middleware atual tem sutilezas a preservar: gate por `Host`, `PROTECTED_BY_METHOD`, compare constant-time (`:77`), e o matcher de extensões estáticas (`:141`). Revisar o diff, não só rodar |
| **Fase 2** — escopo | Sonnet | Encolheu para 2 endpoints (§4.1). Atenção ao caso especial `GIO_SERVICES` (`ProjectContext.tsx:161,169-174`) |
| **Fase 3** — telas de gestão | Sonnet | CRUD puro, dois moldes prontos (`admin/page.tsx`, `admin/catalog/page.tsx`). Maior volume de código, menor risco — é onde o custo do Sonnet compensa mais |
| **Fase 4** — botões + 403 + auditoria | Sonnet | Mecânico, mas **largo** (9 arquivos). O inventário da §4.2 já é a checklist; seguir item a item |
| **Fase 5** — matar modo público | Sonnet | É remoção. Referência órfã não compila (`strict: true`). O risco aqui é operacional, não de código — a decisão de rodar é humana |
| **Fase 6** — SAML/Okta | **Opus** + revisão de segurança | Única parte com falha silenciosa de verdade: validação de asserção (assinatura, replay, clock skew, audience restriction) erra quieto. Depende de metadata do GIO, não testa direito local |

**Resumo:** todo o trabalho de agora (Fases 1-5) é Sonnet. Opus só na Fase 6,
que depende da demanda MMS e não começa tão cedo.

### Como rodar o Sonnet bem aqui

- **Uma fase por sessão.** Não emendar Fase 3 em Fase 4 no mesmo contexto.
- **Passar a seção do plano junto com os `file:line`** — este documento já traz
  as referências verificadas; usar como entrada, não pedir para redescobrir.
- **Fase 4: exigir a checklist da §4.2 marcada item a item** no relato final.
  Tarefa larga sem checklist é onde some coisa.
- **Rodar `npm run build` ao fim de cada fase.** É o que converte esquecimento
  em erro visível.
