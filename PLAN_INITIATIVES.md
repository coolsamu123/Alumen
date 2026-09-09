# Plano: Iniciativas — pastas do Drive sem projeto no Excel

Hoje a aplicação só enxerga o que a planilha CDIO já governa. Este plano abre
um segundo caminho de entrada: uma pasta do Google Drive vira um nó de primeira
classe na análise de impacto **sem precisar existir no Excel e sem exigir que
as equipes adotem qualquer convenção de nomes**.

Auditoria feita sobre `drive-engine.ts`, `goals-scanner.ts`, `impact-engine.ts`,
`project-id.ts` e o banco real (2026-09-01).

## O caso de uso

> "Quero saber os impactos de uma iniciativa que ainda não tem projeto, mas já
> tem documentos."

A pessoa cria uma pasta no Drive com o nome que quiser (`Migração faturamento
SAP`), joga os documentos dentro, e a iniciativa aparece nas views e na análise
de impacto junto com os projetos formais.

## Não-objetivos

- Criar a pasta no Drive pela aplicação. A service account é `drive.readonly`
  (`drive-engine.ts:91`); o `mkdir` é humano.
- Promover uma iniciativa a projeto quando ela vira PRJ de verdade. Fica para
  depois (ver *Questões em aberto*).
- Mudar o prompt do Goals Extractor. Iniciativa e projeto são analisados pelo
  mesmo prompt.

## Estado atual (medido 2026-09-01)

| | |
|---|---|
| Projetos distintos em `projects` (via Excel) | 301 |
| Com algum link `drive.google.com` | 93 |
| Pastas baixadas em `data/drive/` | 61 |
| Com `project_goals.status='success'` → **visíveis nas views** | **61** |
| Raízes de descoberta configuradas (`drive_watch_roots`) | 0 |
| `app_settings.discovery_root` | ausente |

### O que realmente filtra o que se vê

As views **não** leem a tabela `projects`. Leem `project_goals` com um
`LEFT JOIN projects` (`impact-engine.ts:35-37`):

```sql
FROM project_goals g
LEFT JOIN projects p ON g.project_id = p.project_id
WHERE g.project_id != '' AND g.status = 'success' AND g.output_language = ?
```

Consequência que sustenta este plano inteiro: **qualquer linha que chegue em
`project_goals` aparece nas views, mesmo sem linha correspondente em
`projects`.** O destino já aceita o que queremos. O que trava está no funil
que alimenta `project_goals`, e é sempre a mesma trava — o nome da pasta.

| # | Etapa | Onde | Trava |
|---|---|---|---|
| 1 | Descoberta no Drive | `drive-engine.ts:524` | Só reconhece pasta cujo nome case `PRJ<dígitos>`. Outros nomes são atravessados recursivamente e nunca viram nada |
| 2 | Casamento com o portfólio | `drive-engine.ts:611` | Busca só entre `project_id LIKE 'PRJ%'` |
| 3 | Download | `drive-sync-all.ts:203` | Dirigido por `projects.link_folder`. Sem linha na tabela, não baixa |
| 4 | Scanner de goals | `goals-scanner.ts:76`, `:118` | Ignora todo diretório em `data/drive/` que não case `^(PRJ\|PGM)\d+` |
| 5 | Contagem de arquivos | `drive-engine.ts:971` | `/^(PRJ[0-9]+)/` — perde até PGM hoje (bug pré-existente) |

Nenhuma dessas travas é arquitetural. São cinco expressões regulares e dois
filtros SQL.

## Decisões de design

### D1 — O código da iniciativa é interno e atribuído pela aplicação

Descartada a alternativa de pedir que alguém digite `INI-0001` no nome da
pasta.

O motivo pelo qual códigos numerados são úteis em `PRJ` é que eles **aparecem
no texto dos documentos**: `extractProjectIds` (`project-id.ts:75`) varre a
prosa procurando referências cruzadas, e é assim que um projeto passa a citar
outro. Para iniciativas isso não vale — os documentos que as equipes escrevem
não carregam código nenhum. Um código digitado à mão seria puro custo
cerimonial, sem o benefício que justifica o dos projetos.

Então: pasta com nome livre, código gerado pela aplicação, invisível ao usuário.

### D2 — A identidade é o id da pasta no Drive, não o nome

Para `PRJ`, a identidade **é** o nome da pasta — renomear cria um projeto novo.
Para iniciativas isso seria inaceitável, porque o nome é livre e vai mudar
("Migração SAP" → "Migração SAP — fase 1").

O mapeamento `drive_folder_id → INI code` fica numa tabela. Renomear a pasta
muda o nome exibido e nada mais.

### D3 — Forma canônica `INI` + 7 dígitos

Internamente o código segue a mesma forma canônica dos demais
(`project-id.ts:19-47`): prefixo + 7 dígitos com zero-padding + sufixo alfa
opcional. Adicionar `INI` a `PREFIX_ALIASES` faz todo o encanamento existente
— padding, tolerância a separador, `sameProject`, `normalizeProjectId` — passar
a funcionar sem nenhuma outra alteração.

A alternativa (slug tipo `INI_MIGRACAO_SAP`) exigiria um ramo paralelo em
`canonicalise()` e em toda chamada de `normalizeProjectId`, que hoje devolve
`null` para qualquer coisa sem dígitos — e `null` significa "não é referência a
projeto", ou seja, a iniciativa seria descartada em `goals-analyzer.ts:200`,
`impact-engine.ts:836`, `:852`, `:1456`.

### D4 — Uma raiz de iniciativas, subpastas diretas

Toda subpasta **direta** da raiz designada é uma iniciativa. Sem recursão: se
recursasse, cada subpasta de organização interna viraria uma iniciativa
separada.

Contraste deliberado com a descoberta de projetos, que recursa até 5 níveis
procurando nomes `PRJ` — lá a recursão existe porque as pastas estão espalhadas
numa hierarquia que não controlamos.

### D5b — Uma iniciativa que some do Drive é marcada, nunca apagada

Resposta à questão 2. `initiatives.missing_since` passa de NULL a um timestamp
quando uma varredura da raiz não encontra mais a pasta; a linha em `projects`,
os goals e as arestas de impacto ficam intactos. A UI mostra um selo
`fora do Drive`. Se a pasta reaparecer, `missing_since` volta a NULL.

Apagar perderia arestas de impacto que custaram chamadas de LLM para calcular, e
uma pasta pode sumir por motivo trivial (movida, permissão retirada por engano).

### D5 — Procedência explícita na UI

Uma iniciativa não tem gate, custo, DDS nem data de revisão. Sem um rótulo, ela
aparece como um projeto com metade das colunas vazias e polui a leitura do
portfólio governado. Coluna `source` em `projects` (`excel` | `drive` | `initiative`)
+ badge nas views.

Isso também resolve, de graça, a outra metade do pedido: **projetos que estão
no Drive e não no Excel** passam a ser distinguíveis (`source='drive'`) em vez
de se misturarem aos governados.

### O que muda na análise de impacto (e o que não muda)

Uma iniciativa entra na análise como qualquer outro nó. Vale registrar por que
isso funciona apesar de não haver código nos documentos:

- **Direção iniciativa → projetos.** Os documentos da iniciativa mencionam PRJs
  reais, porque projetos formais têm código e as pessoas os citam. Isso é
  extraído normalmente e é o sinal mais forte para o caso de uso.
- **Direção projetos → iniciativa.** Nenhum documento de projeto vai citar
  `INI0000001`. Esse sinal é perdido — mas ele é **um de quatro**. O prefiltro
  de pares (`impact-engine.ts:418-451`) usa tecnologia, fornecedor, GIO service
  line e menção. A medição registrada no próprio código (61 projetos, 1830
  pares, 30 impactos reais) mostra `tech OR vendor OR mention` preservando 28
  de 30, e `...OR GIO` preservando 29 de 30 — os sinais que sobrevivem carregam
  quase tudo.
- **E hoje o prefiltro nem roda.** Ele só entra quando a cobertura total não
  cabe em 200 lotes (`impact-engine.ts:559-593`). Com 61 projetos e lotes de
  22, a cobertura total precisa de ~15–20 lotes: o modo é `full`, todo par vai
  ao LLM. A iniciativa é comparada contra todos os projetos independentemente
  de qualquer menção. Quando isso deixar de valer, o código já avisa na UI
  (`impact-engine.ts:1336`).

## Arquitetura

### Schema

Duas mudanças, ambas no idioma de migração já usado em `db.ts` — `ALTER TABLE`
dentro de `try/catch` para ser idempotente (`db.ts:370`, `:375`):

```sql
-- Mapeamento estável pasta-do-Drive → código interno.
CREATE TABLE IF NOT EXISTS initiatives (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL UNIQUE,   -- INI0000001, atribuído aqui
  drive_folder_id TEXT NOT NULL UNIQUE,   -- a identidade real (D2)
  folder_name     TEXT NOT NULL,          -- nome livre, vira o display name
  root_id         INTEGER,                -- FK drive_watch_roots.id
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Procedência (D5).
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'excel';

-- Distingue raiz de portfólio de raiz de iniciativas (D4).
ALTER TABLE drive_watch_roots ADD COLUMN kind TEXT NOT NULL DEFAULT 'portfolio';
```

`source` com default `'excel'` deixa as 301 linhas existentes corretas sem
backfill. O backfill real é para `'drive'`: linhas criadas por `createMissing`,
que não vieram da planilha. `batch_id = ''` é o discriminador — verificado no
banco atual: as 301 linhas têm `batch_id` preenchido, porque só o
`excel-parser.ts:150` o escreve; o INSERT de `drive-engine.ts:649` deixa o
default vazio.

A atribuição do próximo número é `MAX(digits) + 1` sobre `initiatives`, dentro
da mesma transação do INSERT, para não haver corrida entre workers.

### Descoberta

Função nova em `drive-engine.ts`, irmã de `discoverAndAddProjectFromDrive()`:

```ts
export async function discoverInitiativesFromDrive(
  rootUrl: string,
): Promise<{ created: Initiative[]; seen: Initiative[]; renamed: Initiative[] }>
```

Fluxo, para cada subpasta direta da raiz:

1. `initiatives` já tem esse `drive_folder_id`? Não → aloca o próximo `INI`,
   insere em `initiatives` **e** em `projects` com `source='initiative'`,
   `name = folder_name`, `link_folder = <url da pasta>`.
2. Já tem → atualiza `last_seen_at`; se o nome mudou, atualiza `folder_name` e
   `projects.name` (D2: sem criar duplicata).
3. Em ambos os casos, garante que `link_folder` aponta para a pasta.

Como a linha em `projects` ganha `link_folder`, o download
(`drive-sync-all.ts:203`) e todo o resto do pipeline passam a incluir a
iniciativa **sem nenhuma alteração** — é por isso que a inserção em `projects`
vale a pena em vez de uma tabela paralela.

### Reconhecimento do prefixo

| Arquivo | Linha | Mudança |
|---|---|---|
| `project-id.ts` | 30 | `INI: 'INI'` em `PREFIX_ALIASES` |
| `goals-scanner.ts` | 76 | `PRJ_FOLDER_NAME` → `(?:PRJ\|PGM\|INI)` |
| `drive-engine.ts` | 971 | `/^(PRJ[0-9]+)/` → `/^((?:PRJ\|PGM\|INI)[0-9]+)/` — corrige PGM de quebra |
| `drive-engine.ts` | 611 | `LIKE 'PRJ%'` → remover o filtro (a query já é por id canônico) |
| `impact-engine.ts` | 1019 | `startsWith('PRJ')` → `isProjectId()` de `project-id.ts` |
| `api/drive/sheet/route.ts` | 13 | `startsWith('PRJ')` → `isProjectId()` |

`drive-engine.ts:524` (`PRJ_FOLDER_REGEX`) e `normalizePrjMatch` **não** mudam:
são a descoberta de projetos por nome, que segue exclusiva de `PRJ`.

`file-hygiene.ts:66` também não muda, e o comportamento resultante é o
desejado: numa pasta `INI`, o `projMatch` de `/^PRJ([0-9]+)/` falha, a regra de
`cross_prj` não se aplica e nenhum arquivo é descartado. Correto — uma pasta de
iniciativa contém legitimamente documentos que citam vários projetos.

### API e UI

- `POST /api/auto-discovery` ganha `kind` no body (`'portfolio' | 'initiatives'`),
  repassado a `addWatchRoot()` (`auto-pipeline.ts:288`).
- `runAutoDiscoveryCycle()` (`auto-pipeline.ts:161`) despacha por `kind`:
  `discoverAndAddProjectFromDrive` ou `discoverInitiativesFromDrive`.
- `ExplorerRow` (`api/drive/projects/route.ts`) e `ProjectSummary`
  (`types.ts:42`) ganham `source`.
- Badge em `DriveView` e `Sidebar`; filtro por procedência na toolbar.

## Lotes

| Lote | Conteúdo | Entregável verificável |
|---|---|---|
| 1 | Schema: `initiatives`, `projects.source`, `drive_watch_roots.kind` + backfill | Migração roda sobre o banco atual sem perder as 301 linhas |
| 2 | `discoverInitiativesFromDrive()` + alocação de código | Apontar para uma pasta de teste com 3 subpastas cria 3 linhas `INI` |
| 3 | Prefixo nas 6 posições da tabela acima | Pasta `INI0000001` em `data/drive/` é vista por `scanProjects()` |
| 4 | Fio ponta a ponta: descoberta → download → goals | A iniciativa aparece nas views com goals extraídos |
| 5 | Procedência na UI (badge + filtro) | Dá para separar governado de exploratório de relance |
| 6 | Backfill `source='drive'` + ligar a raiz de portfólio com `createMissing` | Projetos do Drive fora do Excel passam a ser visíveis e rotulados |

Lotes 1–4 entregam o caso de uso do usuário e valem sozinhos. Lote 6 é a outra
metade do pedido (Drive sem Excel) e é sobretudo configuração.

## Estado da implementação (2026-09-01)

Lotes 1–6 implementados e em produção. Migração aplicada sobre o banco real sem
perda: 301 projetos, 61 goals, 287 arestas de impacto preservados.

| Lote | Estado | Onde |
|---|---|---|
| 1 | ✅ | `db.ts` — tabela `initiatives`, `projects.source`, `drive_watch_roots.kind`, backfill |
| 2 | ✅ | `drive-engine.ts` — `discoverInitiativesFromDrive()`, `listChildFolders()`, `nextInitiativeId()` |
| 3 | ✅ | `project-id.ts`, `goals-scanner.ts`, `drive-engine.ts`, `impact-engine.ts`, `api/drive/sheet` |
| 4 | ✅ | `auto-pipeline.ts` despacha por `kind`; ação `discover_initiatives` em `/api/drive` |
| 5 | ✅ | Coluna **Origem** + selo `fora do Drive` no `DriveView`; selo no `Sidebar` |
| 6 | ✅ | Backfill por `batch_id = ''`; stubs de `createMissing` agora nascem `source='drive'` |
| D5b | ✅ | `missing_since` marcado, nunca apagado |

Desvios do plano, ambos deliberados:

- **`api/drive/sheet:13`** usa `normalizeProjectId` em vez do `isProjectId` que o
  plano previa. `isProjectId` sozinho aceitaria `"PGM 1197"` e gravaria o id com
  o espaço; canonicalizar alinha essa rota com o que o importador de Excel já faz.
- **A ação `discover_initiatives` registra a raiz** em `drive_watch_roots` antes
  de varrer. Uma pasta de iniciativas é um lugar vivo — subpastas e documentos
  são acrescentados depois —, então uma varredura de uma vez só teria a forma
  errada. Registrar também limita a marcação de "sumiu do Drive" à raiz varrida.

Verificado em execução, contra uma cópia do banco real:

| Verificação | Resultado |
|---|---|
| Migração preserva o portfólio | 301 / 61 / 287, iguais a antes |
| `normalizeProjectId('INI0000001')` | `INI0000001` |
| Menções num documento de iniciativa | `['PRJ0018641', 'PRJ0017301']` extraídos |
| `scanProjects()` vê `data/drive/INI0000001/` | sim, com os arquivos |
| Contagem de arquivos de PGM (bug pré-existente) | corrigida — antes 0 |
| `npm run build` | limpo (lint + tipos) |

E contra a API real do Drive (numa cópia do banco, raiz de teste com 4 subpastas):

| Cenário | Resultado |
|---|---|
| 1ª varredura | 4 iniciativas criadas, cada uma com seu `link_folder` e `source='initiative'` |
| 2ª varredura (idempotência) | 0 criadas, 4 reconhecidas |
| Pasta renomeada no Drive | 1 renomeada, **ainda 4 iniciativas** — sem duplicata (D2) |
| Raiz vazia | 4 marcadas `missing_since`, 0 apagadas (D5b) |
| Raiz inacessível | erro explícito, **0 marcadas** — ver abaixo |

**Bug encontrado e corrigido durante esse teste.** `files.list` sobre um parent
inexistente — id com erro de digitação, pasta apagada, compartilhamento
retirado da service account — devolve lista vazia, não erro. Sem guarda, essa
lista vazia é indistinguível de "todas as iniciativas foram removidas", e uma
URL errada marcaria a raiz inteira como sumida. `discoverInitiativesFromDrive`
agora confirma que a raiz existe com um `files.get` antes de ler qualquer coisa,
e lança em vez de marcar.

### Segundo bug, encontrado no primeiro uso real

A descoberta funcionou de primeira (raiz `1e8pLQ…`, iniciativa `INI0000001`
DOC2DATA, 3 arquivos baixados), mas a linha não aparecia no Project Explorer.

A causa não tinha nada a ver com iniciativas. Cinco rotas GET que leem estado
mutável não recebem o argumento `request`, e o build de produção do Next as trata
como estáticas: a resposta é **prerenderizada durante o `npm run build`** e
gravada em `.next/server/app/api/*.body`, depois servida indefinidamente. O
explorer estava congelado no retrato tirado no build — qualquer projeto criado
depois ficava invisível até o build seguinte.

Latente desde a mudança para systemd/produção (`a36d0ee`); sob `next dev` nada é
prerenderizado, então nunca apareceu. A iniciativa só foi a primeira linha nova
a ser criada depois de um build.

Corrigido com `export const dynamic = 'force-dynamic'` em
`api/drive/projects`, `api/drive/state`, `api/services`, `api/strom/stats` e
`api/auto-discovery/stats`. Verificação: `.next/server/app/api/**/*.body` agora
sai vazio no build, e o explorer devolve 302 linhas.

### O que não foi implementado

**Promoção de iniciativa para projeto** (questão 1). A decisão está registrada —
migrar goals e impactos para o novo id —, mas o plano a listava como
não-objetivo e nenhum lote a cobria. Exige reescrever `project_goals`,
`projects_impact` nas duas direções, `documents_cache`, `impact_deep_dives` e
renomear o diretório em `data/drive/`, mais uma affordance na UI.

## Riscos e limites

| Risco | Avaliação |
|---|---|
| Pasta de iniciativa com documentos demais | O teto por projeto (`STROM_GOALS_MAX_CHARS`, 300k) já corta. Sem novidade |
| Crescimento de pares na análise de impacto | N² sobre 61. Poucas iniciativas é irrelevante; dezenas aproximam o teto de 200 lotes e derrubam para modo `filtered` — que já é avisado na UI |
| Teto diário de LLM | `STROM_LLM_DAILY_CAP` = 500. Cada iniciativa nova custa 1 extração + os pares |
| Subpasta criada por engano vira iniciativa | Mitigado por D4 (só nível 1) e pela raiz ser designada explicitamente. Excluir a linha em `initiatives` e `projects` desfaz |
| Colisão de número em execução concorrente | Alocação dentro da transação do INSERT; `UNIQUE(project_id)` é a rede de segurança |

## Questões em aberto

1. ~~**Promoção.**~~ **Decidido:** migrar goals e impactos para o novo id.
   Ainda não implementado (ver *O que não foi implementado*).
2. ~~**Retenção.**~~ **Decidido e implementado:** apenas marca, nunca apaga —
   ver D5b.
3. **Nome da raiz.** `Iniciativas/` é sugestão — só precisa ser uma pasta
   estável compartilhada com
   `al-bco-e9997-talend-etl@al-bco-e9997-talend-etl-292614.iam.gserviceaccount.com`.
   
