# Plano: tema por usuário e trilha de auditoria

Duas entregas que se apoiam na mesma base, que é saber **quem** está do outro lado de cada requisição:

1. **Tema por usuário.** Cada pessoa escolhe System, Light, Dark ou Dim, e a escolha vai junto com ela para qualquer navegador e dispositivo, como em qualquer aplicativo.
2. **Auditoria.** Uma área administrativa responde "quem fez o quê, quando, em quê e com qual resultado" para as ações críticas: apagar dados, mudar acesso, trocar segredos e disparar execuções caras.

Levantamento feito sobre `middleware.ts`, `lib/auth.ts`, `lib/session.ts`, `lib/users-repo.ts`, `lib/db.ts`, `lib/auto-pipeline.ts`, `lib/scheduler.ts`, `app/layout.tsx`, `context/ProjectContext.tsx`, as 44 rotas em `src/app/api/` e a configuração do nginx (2026-09-14).

---

## 0. Status

| Fase | O quê | Estado |
|---|---|---|
| 0 | Fechar o recheck de sessão nas rotas de escrita (§1) | ⬜ |
| 1 | Tema por usuário (§2) | ⬜ |
| 2 | Núcleo da auditoria + eventos de acesso e identidade | ⬜ |
| 3 | Eventos destrutivos, de configuração, de execução e de entrada/saída | ⬜ |
| 4 | Área `/admin/audit` | ⬜ |
| 5 | Opcional: retenção automática, cadeia de hash, "disparado por" nas views, alertas | ⬜ |

A Fase 0 vem primeiro porque é uma falha de segurança, e porque o conserto é a mesma linha de que a auditoria precisa para identificar o ator. **Ela não depende de nenhuma decisão do §5 nem das outras fases, e pode ir para produção sozinha, antes de todo o resto.** Enquanto não sai, vale a mitigação operacional do §1.

---

## 1. Achado que vem antes de tudo: 21 rotas de escrita não reconferem a sessão

O `PLAN_USER_MANAGEMENT.md` §2.2 definiu duas camadas:

- **Middleware (Edge):** confere só a assinatura e a validade do cookie.
- **Handler (Node):** relê o usuário no SQLite via `getSession()`/`requireAdmin()`. É essa camada que faz valer `is_active` e `token_version`.

A segunda camada existe em só 9 rotas. **As outras 21 rotas com POST/PUT/PATCH/DELETE confiam apenas no middleware**, e o middleware lê o `role` que está *dentro do cookie*:

| Rota | O que ela faz sem reconferir |
|---|---|
| `api/goals` (`delete_everything`, `start`, `start_single`) — `goals/route.ts:54` | apaga todos os goals / dispara LLM |
| `api/admin/clear-cache` — `clear-cache/route.ts:4` | apaga `analysis_cache` e `documents_cache` |
| `api/admin/config` POST — `config/route.ts:68` | troca a chave Gemini, o modelo e o idioma de saída |
| `api/admin/service-account` POST/DELETE | troca ou remove a credencial do Google |
| `api/prompts` POST — `prompts/route.ts:14` | reescreve os prompts de extração |
| `api/drive` (`delete_everything`, `start`, `add_link`…) — `drive/route.ts:52` | apaga os dados do Drive / sincroniza |
| `api/drive/sheet` (`save`) — `drive/sheet/route.ts:129` | importa projetos para a base |
| `api/drive/sync-all` POST/DELETE, `api/drive/run` | sync completo / para / reseta |
| `api/auto-discovery` POST/DELETE, `/run`, `/toggle` | adiciona, remove ou liga pastas vigiadas; dispara ciclo |
| `api/impact/project/planning`, `/planning/run-all` POST/DELETE, `/deep-dive` POST | execuções com LLM |
| `api/projects/upload`, `api/projects/[id]/services` | importa planilha / edita serviços |
| `api/services/mapping` POST, `api/analyze`, `api/analyze/document`, `api/admin/test-gemini` | mapeamentos / LLM ad hoc |

**Cenário:** às 10h um admin é rebaixado para basic ou desativado. `setUserRole`/`setUserActive` (`users-repo.ts`) incrementam `token_version`, mas o cookie dele continua assinado, dizendo `role: 'admin'` e valendo por até 30 dias (`SESSION_MAX_AGE_SECONDS`). O middleware aceita esse cookie. O handler de `/api/goals` não relê nada, então `delete_everything` funciona. A proteção só vale nas rotas que já chamam `requireAdmin()` (`admin/users/*`, `admin/catalog`, `admin/upstream-test`, `impact`, `drive/queue`).

Verificado lendo o código. Não reproduzi em produção, porque isso exigiria rebaixar uma conta real. O teste de reprodução está no critério de pronto da Fase 0.

**Exposição hoje** (consulta somente leitura no `cioo.db`, 2026-09-14):

- 3 contas, das quais 2 são admins ativos. Nenhuma está desativada.
- 1 conta com perfil basic já teve o `token_version` incrementado (por troca de perfil, desativação ou reset de senha) e fez login nos últimos 30 dias.
- O banco não guarda *quando* nem *por que* a versão subiu, que é exatamente o que a auditoria vai registrar. Por isso não dá para saber se essa conta ainda tem um cookie antigo com `role: 'admin'`. Se o incremento veio de uma troca admin → basic depois desse login, tem.

**Mitigação sem código, disponível agora:**

1. Trocar o `SESSION_SECRET` no `.env.local`, por exemplo com `openssl rand -hex 32`.
2. Rodar `sudo systemctl restart alumen`.

Todo cookie emitido até ali perde a validade na hora, e as 3 contas precisam entrar de novo. Enquanto a Fase 0 não estiver no ar, repetir isso sempre que alguém for rebaixado ou desativado.

**Conserto:**

1. Todo handler de escrita começa com `const actor = await requireAdmin(); if (isSessionError(actor)) return …`. Isso custa uma leitura de SQLite por requisição de escrita, o que é irrelevante.
2. `scripts/check-admin-guards.mjs`, rodando como `prebuild` no `package.json`, falha se algum `route.ts` sob os prefixos protegidos exporta POST/PUT/PATCH/DELETE sem chamar `requireAdmin(`. Pelo `EC2_SETUP.md`, um build que falha não publica, e o serviço segue com o build anterior. Assim a regra não se perde na próxima rota nova.
3. Rotas públicas por definição (`auth/login`, `auth/logout`) e rotas de qualquer usuário logado (a nova `api/me/preferences`) ficam numa allowlist explícita do script.

---

## 2. Tema por usuário

### 2.1 Hoje

A escolha vive em `localStorage['strom-theme']`, lida pelo `THEME_BOOT` em `layout.tsx` e pelo `ProjectContext`. Consequências:

- **Máquina compartilhada:** a próxima pessoa herda o tema de quem usou antes.
- **Dispositivo novo, outro navegador ou cache limpo:** volta ao padrão.
- **Nada sincroniza:** escolher Dim no notebook não muda o celular (`/m`).

### 2.2 Modelo

```sql
-- Preferências por usuário. Ausência de linha = "nunca escolheu", o que é
-- diferente de ter escolhido 'system' — a migração do localStorage (§2.4)
-- depende dessa distinção.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key)
);
```

**Por que uma tabela chave/valor e não uma coluna `users.theme`:**

- A coluna teria um default, e aí não daria para distinguir "nunca escolheu" de "escolheu System".
- As próximas preferências já são previsíveis: view inicial, sidebar recolhida, filtros salvos. Cada uma viraria um `ALTER TABLE`.

A validação fica no código, com uma allowlist de chaves e valores em `src/lib/preferences.ts`:

```ts
export const PREFERENCES = {
  theme: ['system', 'light', 'dark', 'dim'],
} as const;
```

Uma chave ou um valor fora da lista retorna 400. Nada chega ao banco sem passar por essa lista.

### 2.3 Fluxo

**O servidor passa a ser a fonte da verdade para quem está logado.** O `layout.tsx` já chama `getSession()` em toda renderização, então basta ler a preferência na mesma ida ao banco:

| Preferência salva | O que o servidor renderiza | Flash? |
|---|---|---|
| `light` / `dark` / `dim` | `<html data-theme="dim" data-theme-pref="dim">` — tema final já no HTML | nenhum, e o script de boot nem precisa agir |
| `system` ou sem linha | `<html data-theme="dark" data-theme-pref="system">` + `THEME_BOOT` resolve via `prefers-color-scheme` | o mesmo de hoje |
| sem sessão (`/login`) | sem `data-theme-pref`; `THEME_BOOT` cai no `localStorage` | o mesmo de hoje |

Mudanças:

- **`THEME_BOOT` (`layout.tsx`):** lê `data-theme-pref` do `<html>` antes de tudo. Com `light`, `dark` ou `dim`, não faz nada. Com `system`, usa `matchMedia`. Sem o atributo, usa o `localStorage`, que vira só cache para a tela de login.
- **`ProjectProvider`:** recebe `initialThemePreference` do layout, como já recebe `user`. Isso elimina o estado `null` e a leitura no mount que existem hoje em `ProjectContext.tsx`.
- **`setThemePreference`:** aplica na hora (otimista), grava no `localStorage` e envia `PUT /api/me/preferences`. Se o PUT falhar, o visual fica como está e a próxima troca tenta de novo. Não vale interromper a pessoa por causa de um tema.
- **Abas abertas:** escutar o evento `storage` do `localStorage` para que a troca numa aba reflita nas outras sem recarregar. Custa poucas linhas.
- **`/m` e `/admin/*`** usam o mesmo `layout.tsx` e herdam tudo sem mudança.

### 2.4 Migração de quem já escolheu

Na primeira carga depois do deploy, se o servidor mandar `data-theme-pref` sem linha gravada (o atributo `data-theme-pref-source="default"` indica isso) e o `localStorage` tiver um valor válido, o cliente envia esse valor uma única vez no PUT. Quem já tinha escolhido Dim neste navegador continua em Dim, e agora em todos os lugares.

Se duas máquinas tiverem valores diferentes, vale a primeira que carregar. As seguintes já encontram a linha gravada e seguem o servidor.

### 2.5 API

| Método | Rota | Acesso | Corpo / resposta |
|---|---|---|---|
| GET | `/api/me/preferences` | qualquer usuário logado | `{ theme: 'dim' }` |
| PUT | `/api/me/preferences` | qualquer usuário logado | `{ theme: 'dim' }` → `{ ok: true }` |

- O middleware já exige sessão para tudo que não é `PUBLIC_PATHS`, e `/api/me` não está nas listas de admin. Nada muda lá.
- O handler usa `getSession()`, não `requireAdmin()`, e grava **só** para `session.id`. Não existe parâmetro de usuário, então ninguém altera a preferência de outra pessoa.
- **Preferência não é auditada.** Não é ação crítica, e registrá-la encheria o log de ruído.

### 2.6 Arquivos

| Arquivo | Mudança |
|---|---|
| `src/lib/db.ts` | `CREATE TABLE user_preferences` |
| `src/lib/preferences.ts` (novo) | allowlist + `getPreferences(uid)` + `setPreference(uid, key, value)` |
| `src/app/api/me/preferences/route.ts` (novo) | GET/PUT |
| `src/app/layout.tsx` | lê a preferência, renderiza `data-theme`/`data-theme-pref`, ajusta `THEME_BOOT` |
| `src/context/ProjectContext.tsx` | `initialThemePreference`, PUT otimista, evento `storage` |
| `THEME_PLAN.md` | nota apontando para cá |

**Critério de pronto:**

- Escolher Dim no Chrome e abrir o Firefox logado com a mesma conta mostra Dim já no primeiro paint.
- Outro usuário, na mesma máquina, vê o próprio tema.
- `PUT {theme: 'neon'}` retorna 400.

---

## 3. Auditoria

### 3.1 O que já existe e por que não responde "quem"

| Registro | Guarda | Não guarda |
|---|---|---|
| `goals_runs`, `impact_runs` (`db.ts:363,384`) | que uma execução começou, progrediu e terminou | quem disparou |
| `auto_runs.trigger` (`db.ts:186`, `auto-pipeline.ts:206`) | `manual` ou `scheduled` | qual pessoa, quando é `manual` |
| `llm_calls` | chamada, modelo, duração | quem pediu |
| `users.last_login_at` | último login bem-sucedido | falhas, histórico, quem mudou o quê na conta |
| `delete_everything`, `clear-cache`, troca de chave, troca de prompt | **nada** | tudo |
| `console.log` no journald | texto solto | ator, estrutura, retenção |

As ações mais destrutivas do sistema são justamente as que não deixam rastro nenhum.

### 3.2 Princípios

1. **Nunca "o quê" sem "quem".** Todo evento tem ator: um usuário (com um retrato do email, do nome e do perfil *no momento*) ou o sistema (agendador).
2. **Só acrescenta.** Triggers do SQLite bloqueiam `UPDATE` sempre e só permitem `DELETE` de linhas além do prazo de retenção. Não existe rota que edite ou apague evento.
3. **Nenhum segredo no log.** Chave de API aparece só como os últimos 4 caracteres. Service account aparece como `client_email` + `private_key_id`, nunca a chave privada. Senha nunca aparece. Um `redact()` com lista de campos proibidos (`password`, `apiKey`, `private_key`, `token`, `secret`) roda antes de todo insert, como segunda barreira.
4. **Retrato, não referência.** `actor_user_id` sem foreign key com cascade: apagar um usuário não pode apagar o histórico do que ele fez. Email e nome ficam copiados na linha.
5. **Destrutivo local: ação e auditoria na mesma transação (fail-closed).** Se o evento não gravar, o `DELETE` também não acontece. Execuções longas ou externas (LLM, Drive) gravam `started` e depois `finished`/`failed`. Nelas, uma falha ao gravar a auditoria só vai para o console e não bloqueia a execução (fail-open).
6. **Limite honesto.** Isso protege contra quem usa o *aplicativo*. Quem tem shell na EC2 consegue editar o `cioo.db` diretamente. Uma cadeia de hash (Fase 5) tornaria essa edição *detectável*, não impossível.

### 3.3 Modelo

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ISO 8601 UTC com Z. As outras tabelas usam datetime('now') sem fuso;
  -- upstream_status.sheet_at (db.ts) já mostrou o custo de horário ambíguo.
  occurred_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'anonymous')),
  actor_user_id INTEGER,                -- sem FK: o histórico sobrevive à exclusão do usuário
  actor_email   TEXT NOT NULL DEFAULT '',
  actor_name    TEXT NOT NULL DEFAULT '',
  actor_role    TEXT,                   -- 'admin' | 'basic' no momento da ação

  action        TEXT NOT NULL,          -- 'goals.erase_all', 'user.role_changed' … (§3.4)
  category      TEXT NOT NULL CHECK (category IN ('access', 'destructive', 'config', 'execution', 'data_io')),
  severity      TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'info')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed', 'started')),

  target_type   TEXT,                   -- 'project' | 'user' | 'config' | 'prompt' | 'watch_root' …
  target_id     TEXT,
  target_label  TEXT,

  details_json  TEXT NOT NULL DEFAULT '{}',   -- antes/depois, contagens, id da execução
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_events(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_events(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target   ON audit_events(target_type, target_id);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- DELETE só além da retenção (§3.7). Mudar a retenção = recriar este trigger.
CREATE TRIGGER IF NOT EXISTS audit_events_retention
BEFORE DELETE ON audit_events
WHEN OLD.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')
BEGIN
  SELECT RAISE(ABORT, 'audit_events rows inside the retention window cannot be deleted');
END;
```

**Journals ganham autoria** (seguindo o padrão `ALTER TABLE … ADD COLUMN` em try/catch que já existe em `db.ts`):

```sql
ALTER TABLE goals_runs  ADD COLUMN triggered_by_user_id INTEGER;  -- NULL = agendador
ALTER TABLE impact_runs ADD COLUMN triggered_by_user_id INTEGER;
ALTER TABLE auto_runs   ADD COLUMN triggered_by_user_id INTEGER;
```

O evento de auditoria guarda o `run_id` em `details_json`, e o journal guarda o usuário. Com isso dá para navegar nos dois sentidos.

### 3.4 Catálogo de eventos

É o que conta como "atividade crítica". Cada linha diz onde o evento nasce e o que fica gravado.

**A. Acesso e identidade**

| Ação | Onde | Severidade | Detalhes |
|---|---|---|---|
| `auth.login_succeeded` | `api/auth/login` | info | IP, user agent |
| `auth.login_failed` | `api/auth/login` | high | email tentado, motivo interno (`no_user` \| `inactive` \| `okta_only` \| `bad_password`). O cliente continua recebendo a mesma mensagem genérica. |
| `auth.logout` | `api/auth/logout` | info | — |
| `user.created` | `api/admin/users` POST | high | email, perfil |
| `user.role_changed` | `api/admin/users/[id]` PATCH | critical | de → para |
| `user.deactivated` / `user.reactivated` | idem | critical / high | — |
| `user.password_reset` | idem | high | só o fato |
| `user.deleted` | `api/admin/users/[id]` DELETE | critical | retrato de email, nome e perfil |
| `user.scopes_replaced` | `api/admin/users/[id]/scopes` PUT | high | escopos antes / depois |
| `user.last_admin_guard` | PATCH/DELETE bloqueado por `wouldRemoveLastAdmin` | critical, `denied` | quem tentou, em quem |
| `auth.stale_privilege` | `requireAdmin()` negando um cookie `role=admin` com `token_version` velho | critical, `denied` | rota, método. É exatamente o cenário do §1. |

**B. Destruição de dados**

| Ação | Onde | Severidade | Detalhes |
|---|---|---|---|
| `goals.erase_all` | `api/goals` `delete_everything` | critical | linhas apagadas |
| `impact.erase_all` | `api/impact` `clear` | critical | linhas apagadas |
| `drive.erase_all` | `api/drive` `delete_everything` | critical | linhas apagadas |
| `cache.cleared` | `api/admin/clear-cache` | high | `deletedAnalyses`, `deletedDocuments` |
| `drive.queue_pruned` | `api/drive/queue` DELETE | high | itens removidos |
| `watch_root.removed` | `api/auto-discovery` DELETE | high | retrato da pasta removida |

**C. Configuração e segredos**

| Ação | Onde | Severidade | Detalhes |
|---|---|---|---|
| `config.gemini_key_changed` | `api/admin/config` POST | critical | últimos 4 caracteres antes / depois |
| `config.model_changed` | idem | high | de → para |
| `config.output_language_changed` | idem | high | de → para (afeta todas as análises futuras) |
| `service_account.uploaded` / `.removed` | `api/admin/service-account` POST/DELETE | critical | `client_email`, `private_key_id` |
| `prompts.updated` | `api/prompts` POST | critical | qual prompt mudou (`goalsPrompt` e/ou `impactPrompt`) e o texto completo antes/depois, só das chaves alteradas (§5, decisão 3) |
| `catalog.entry_updated` | `api/admin/catalog` PATCH | high | diff do verbete |
| `services.mapping_updated` | `api/services/mapping` POST | high | diff |
| `watch_root.added` / `.toggled` | `api/auto-discovery` POST, `/toggle` | high | pasta, ligado/desligado |
| `drive.link_added` | `api/drive` `add_link` | info | projeto, link |

**D. Execução com custo (LLM, Drive)**

| Ação | Onde | Severidade | Detalhes |
|---|---|---|---|
| `impact.run_started` | `api/impact` `start` | high | `run_id`, total de projetos |
| `goals.run_started` | `api/goals` `start` / `start_single` | high / info | `run_id`, escopo |
| `planning.run_all_started` / `_stopped` / `_reset` | `api/impact/project/planning/run-all` | high | — |
| `drive.sync_all_started` / `_stopped` / `_reset` | `api/drive/sync-all` | high | — |
| `pipeline.cycle_started` | `api/auto-discovery/run`, `api/drive/run` | high | modo |
| `pipeline.cycle_finished` | `auto-pipeline.ts` com trigger `scheduled` | info, ator `system` | novos projetos, goals, impactos, erros |
| `deep_dive.generated` | `api/impact/project/deep-dive` POST | info | projeto, alvo, `force` |
| `planning.generated` | `api/impact/project/planning` POST | info | projeto |
| `analyze.adhoc` | `api/analyze`, `api/analyze/document` | info | projetos envolvidos |

**E. Entrada e saída de dados**

| Ação | Onde | Severidade | Detalhes |
|---|---|---|---|
| `projects.uploaded` | `api/projects/upload` | high | nome do arquivo, tamanho, projetos importados |
| `projects.sheet_imported` | `api/drive/sheet` `save` | high | `importedCount` |
| `project.services_changed` | `api/projects/[id]/services` | info | antes / depois |
| `goals.exported_csv` | `api/goals` GET `action=export` | high | linhas exportadas. É dado saindo do aplicativo. |
| `audit.exported_csv` | `api/admin/audit/export` | high | filtros usados |

**Fora do catálogo, de propósito:** leituras comuns, polling de status, preferências, `test-gemini` e `upstream-test` (não mudam estado).

### 3.5 Como instrumentar sem espalhar código

`src/lib/audit.ts` (Node, nunca importado pelo middleware):

```ts
export interface AuditEvent {
  action: string;
  category: 'access' | 'destructive' | 'config' | 'execution' | 'data_io';
  severity: 'critical' | 'high' | 'info';
  outcome: 'success' | 'denied' | 'failed' | 'started';
  target?: { type: string; id: string; label?: string };
  details?: Record<string, unknown>;
}

export function recordAudit(actor: AuditActor, event: AuditEvent, request?: Request): void;
export function actorFrom(session: AuthedUser): AuditActor;
export const SYSTEM_ACTOR: AuditActor;
```

**Três formatos de uso:**

```ts
// 1) Destrutivo local — ação e evento na mesma transação (fail-closed)
const db = getDb();
db.transaction(() => {
  const rows = db.prepare('SELECT COUNT(*) c FROM project_goals').get() as { c: number };
  resetGoalsData(db);
  recordAudit(actorFrom(actor), {
    action: 'goals.erase_all', category: 'destructive', severity: 'critical',
    outcome: 'success', details: { rowsDeleted: rows.c },
  }, request);
})();

// 2) Execução longa — started agora, finished no fim do job
recordAudit(actorFrom(actor), { action: 'impact.run_started', …, outcome: 'started',
  details: { runId } }, request);

// 3) Configuração — antes/depois lidos no próprio handler
recordAudit(actorFrom(actor), { action: 'config.model_changed', …,
  details: { from: before.model, to: after.model } }, request);
```

`getDb()` (`db.ts:11`) devolve sempre a mesma conexão, então `resetGoalsData` (`goals-analyzer.ts:909`), `resetDriveData` (`drive-engine.ts:1217`) e `clearAllImpacts` (`impact-engine.ts:1501`) já rodam dentro de um `db.transaction` aberto no handler, sem mudar a assinatura. Falta só conferir que nenhuma delas faz trabalho assíncrono (arquivo, Drive) no meio, porque o `better-sqlite3` não mantém a transação aberta através de um `await`.

**IP do cliente:** usar só `X-Real-IP`. O nginx define esse header com `$remote_addr` e sobrescreve o que o cliente mandou. `X-Forwarded-For` *acrescenta* ao valor do cliente, então pode ser forjado. Ressalva: isso só vale se a porta 3333 não for alcançável sem passar pelo nginx. Vale conferir o security group e, de preferência, subir o serviço com `next start -H 127.0.0.1`.

**Negações no middleware:** o middleware roda no Edge e não escreve em SQLite, então os 403 dados ali (basic tentando rota de admin) vão só para o console na v1. Os casos interessantes, porém, acontecem no handler e **ficam** registrados: cookie de admin com privilégio vencido (`auth.stale_privilege`), tentativa de remover o último admin e falhas de login.

### 3.6 Área `/admin/audit`

Segue o padrão de `/admin/users` (Tailwind + tokens + `<Tag>`), não o estilo inline de `/admin/page.tsx`. Acesso só para admin, protegido pelo prefixo `/admin` no middleware e por `requireAdmin()` na API.

**Onde se entra:**

- um card novo em `/admin`, ao lado de Target Catalog e User Management;
- em cada linha de `/admin/users`, o link "Activity", que abre a auditoria já filtrada por aquela pessoa.

**A tela:**

```
┌ Audit Trail ─────────────────────────────────────────────────────────────┐
│  Last 7 days    [ 3 critical ]  [ 12 high ]  [ 5 failed logins ]  [ 0 denied ]│  ← contadores = filtros
├──────────────────────────────────────────────────────────────────────────┤
│  Period [7 days ▾]  Person [Anyone ▾]  Category [All ▾]  Severity [≥ high ▾] │
│  Outcome [All ▾]    Search [PRJ0018698, email…          ]     [Export CSV]  │
├──────────────┬────────────────────┬───────────────────┬──────────┬────────┤
│ When         │ Who                │ Action            │ Target   │ Result │
├──────────────┼────────────────────┼───────────────────┼──────────┼────────┤
│ 10:42 · 2h   │ Maria S. · admin   │ Erased all goals  │ —        │ ● ok   │ ▸
│ 09:15 · 3h   │ System (scheduler) │ Pipeline cycle    │ —        │ ● ok   │ ▸
│ 08:03 · 5h   │ joao@… · admin*    │ Stale privilege   │ /api/goals│ ● denied│ ▸
│   ▾ Role changed admin → basic at 07:58 by Maria S. Cookie still said admin.│
└──────────────┴────────────────────┴───────────────────┴──────────┴────────┘
```

- **Quando:** hora local do navegador + tempo relativo. O tooltip mostra o ISO UTC.
- **Quem:** nome, email e o perfil *da época*. O agendador aparece como "System (scheduler)". Um usuário que já foi apagado aparece riscado, com o retrato gravado.
- **Ação:** rótulo legível ("Erased all goals"), não o código `goals.erase_all`. O app é em inglês, então os rótulos também.
- **Alvo:** um projeto vira link para o Project Universe e um usuário vira link para `/admin/users`.
- **Resultado:** `<Tag>` com tom `ok` / `bad` / `warn` / `info` (`started`).
- **Detalhe expansível:** antes/depois lado a lado, contagens, `run_id`, IP e user agent.
- **Padrão ao abrir:** últimos 7 dias, severidade ≥ high. Quem quer tudo muda o filtro.
- **Paginação:** por cursor (`id`), 50 por página. Não usa offset, que fica lento e desalinha quando entram eventos novos.
- **Estado vazio honesto:** "Auditing has been active since 14 Sep 2026. Earlier actions were not recorded."

**API:**

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/admin/audit?since&until&actor&category&severity&outcome&q&cursor&limit` | lista |
| GET | `/api/admin/audit/summary?since` | contadores do topo |
| GET | `/api/admin/audit/export?…mesmos filtros` | CSV (gera `audit.exported_csv`) |

### 3.7 Retenção, volume e privacidade

- **Volume:** a maioria dos eventos tem menos de 1 KB. Mesmo com 500 eventos/dia, bem acima do uso real esperado, seriam ~180 MB/ano. Os únicos eventos grandes são `prompts.updated` com texto completo, e eles são raros.
- **Retenção: 1 ano (365 dias), igual para todas as severidades** (decidido em 2026-09-14). O trigger do §3.3 impõe esse prazo, e um job no `scheduler.ts` apaga uma vez por dia o que passou dele. Se o prazo mudar, é preciso recriar o trigger e ajustar o job juntos.
- **Dados pessoais:** email, nome e IP são dados pessoais. Como a Air Liquide está sob GDPR, a finalidade (segurança e responsabilização) e o prazo de 1 ano devem constar no registro de tratamento de dados.
- **Backup:** a auditoria mora no mesmo `cioo.db`. Restaurar um backup antigo também volta a auditoria no tempo. Isso é aceitável, mas precisa estar documentado.

---

## 4. Fases

### Fase 0: recheck de sessão nas rotas de escrita

- `requireAdmin()` no início das 21 rotas do §1.
- `scripts/check-admin-guards.mjs` + `"prebuild"` no `package.json`.

**Critério de pronto:**

- Com um usuário de teste admin logado em um navegador, rebaixá-lo em outro. Com o cookie antigo, `POST /api/goals {action:'delete_everything'}` retorna **403** e nada é apagado.
- Remover `requireAdmin()` de uma rota qualquer faz o `npm run build` falhar.

### Fase 1: tema por usuário

§2 inteiro.

**Critério de pronto:** os três testes do §2.6.

### Fase 2: núcleo da auditoria + acesso e identidade

- Tabela, índices e triggers (§3.3); `src/lib/audit.ts` com `redact()`.
- Eventos do grupo **A** (§3.4). O `requireAdmin()` da Fase 0 passa a registrar `auth.stale_privilege`.

**Critério de pronto:**

- Um login com senha errada gera exatamente uma linha `auth.login_failed` com `outcome='denied'`.
- `sqlite3 data/cioo.db "UPDATE audit_events SET action='x'"` falha com `append-only`.
- Apagar um usuário mantém as linhas dele, com o email copiado.

### Fase 3: destrutivo, configuração, execução e entrada/saída

- Grupos **B–E** do §3.4.
- `triggered_by_user_id` nos três journals.
- `resetGoalsData`, `resetDriveData` e `clearAllImpacts` chamados dentro de `db.transaction`, junto com o insert da auditoria.

**Critério de pronto:**

- `goals.erase_all` grava a contagem, e forçar um erro no insert da auditoria impede o `DELETE`.
- Trocar a chave Gemini grava só os últimos 4 caracteres, e `grep` pela chave completa no banco não acha nada.
- Um ciclo do agendador aparece com ator `system`.

### Fase 4: área `/admin/audit`

§3.6: tela, filtros, contadores, detalhe expansível, export CSV, card em `/admin` e link "Activity" em `/admin/users`.

**Critério de pronto:**

- Consegue-se responder "quem apagou os goals na semana passada" em menos de três cliques a partir de `/admin`.
- Um basic recebe 403 na página e na API.

### Fase 5: opcional

- **Cadeia de hash:** `prev_hash` + `row_hash` (SHA-256 da linha + hash anterior) e uma checagem em `/admin/audit` que aponta quebra na cadeia.
- **"Disparado por" nas views:** "Last run started by Maria S. · 10:32" no Goals Extractor e no Impact, usando `triggered_by_user_id`.
- **Negações do middleware:** reencaminhadas para a tabela, por exemplo com uma linha estruturada no journald coletada pelo agendador.
- **Alerta imediato** para eventos `critical`. Depende de um canal de saída que a EC2 hoje não tem.

---

## 5. Decisões

### Tomadas (2026-09-14)

| # | Pergunta | Decisão |
|---|---|---|
| 1 | Retenção | **1 ano (365 dias)** para todas as severidades (§3.3, §3.7) |
| 2 | O usuário basic vê a própria atividade? | **Não.** A área é só de admin, e nada de "My activity" nesta entrega. |
| 3 | Guardar o texto completo dos prompts antes/depois? | **Sim**, só do prompt que mudou (detalhe abaixo) |
| 4 | Export de goals em CSV vira evento `high`? | **Sim** (`goals.exported_csv`, §3.4 E) |

### Detalhe da decisão 3: o que fica gravado dos prompts

"Prompts", aqui, são exatamente os dois textos que o `/api/prompts` grava e que o Alumen manda ao Gemini:

| Prompt | Chave | Quem usa | Tamanho atual | Onde se edita |
|---|---|---|---|---|
| Extração de goals | `goalsPrompt` | `goals-analyzer.ts:133`: define os campos que viram Summary, Tech tags, Vendors, DDS/GIO touched, claims e timeline | ~10,6 mil caracteres | Alumen → etapa **Goals** → aba de prompt (`StromArchitecture/panels/DetailPanel.tsx:221`) |
| Detecção de impacto | `impactPrompt` | `impact-engine.ts:804`: define como os projetos são comparados e o que vira impacto, severidade e explicação | ~7,9 mil caracteres | Alumen → etapa **Impact** → aba de prompt |

O prompt do Deep Dive **não** entra aqui. Ele é montado em tempo de execução por `deep-dive-engine.ts` e não é editável pela tela.

**Por que importa:** mudar um desses textos muda o resultado de toda extração ou análise seguinte, para o portfólio inteiro, sem deixar marca nos dados. Sem o texto anterior, a auditoria só consegue dizer que "alguém mudou o prompt de goals às 10h". Não dá para saber o que mudou nem restaurar a versão anterior.

**Decidido:** texto completo antes e depois, só da chave que de fato mudou. A tela reenvia os dois prompts a cada salvamento (`DetailPanel.tsx:247`), então o handler compara campo a campo e ignora o que veio igual. Isso dá no máximo ~37 KB por evento, e edições são raras.

**Detalhe descoberto no caminho:** hoje não existe `data/prompts.json`, então valem os textos padrão do código (`prompts.ts`). No primeiro salvamento pela tela, o arquivo é criado e passa a valer **no lugar** do código. A partir daí, qualquer melhoria de prompt que chegue por deploy é ignorada sem aviso. A auditoria registraria esse primeiro salvamento, mas não resolve esse comportamento. Ele merece uma decisão própria, fora deste plano.

## 6. Fora do escopo

- SSO Okta (`PLAN_USER_MANAGEMENT.md` §8). O modelo daqui não muda com ele: ator é `user_id` + email.
- Enviar a auditoria para um SIEM externo.
- Auditar leituras comuns (quem abriu qual projeto).
