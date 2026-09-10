# Plano: Data Flow ao vivo + fila de projetos pela UI

Tornar visível — e acionável de dentro do Alumen — a cadeia inteira que hoje
começa fora dele: os dois Apps Scripts que rodam no ambiente Air Liquide com o
usuário nominal, copiando arquivos do Drive corporativo para a pasta base à qual
o service account tem acesso.

Dois objetivos, nesta ordem:

1. **Observar** — a página Data Flow deixa de ser um desenho estático e passa a
   mostrar cada projeto atravessando as 6 etapas, ao vivo.
2. **Acionar** — um usuário adiciona um projeto novo pela tela do Alumen, sem
   abrir o editor do Apps Script.

Auditoria feita sobre os dois Apps Scripts (`syncProjectFiles` e
`removeClassification*`), `sheets-engine.ts`, `drive-engine.ts`,
`drive-panel-state.ts`, `api/drive/stream/route.ts`, `api/drive/sheet/route.ts`,
`auto-pipeline.ts`, `middleware.ts`, `auth.ts`, `db.ts` e
`public/dataflow.html` (2026-09-09).

---

## 0. Status

| Fase | Estado | Quando |
|---|---|---|
| 0 — Verificações no ambiente AL (§6.1) | ✅ **done — rodada pelo service account**, ver §0.1 | 2026-09-09 |
| 1 — Leitura: as duas planilhas viram estado no Alumen | ✅ **done — implantado**, via export XLSX (§0.2). Ver §0.3 | 2026-09-09 |
| 2 — Data Flow ao vivo (só leitura) | ✅ **done — implantado**, ver §0.4 | 2026-09-09 |
| 3 — Fila pela UI, via **arquivo de fila** no Drive (§0.2) | ⬜ | — |
| 4 — Worker permanente no Apps Script | ⬜ | — |
| 5 — Acabamento: heartbeat, erros, retry | ⬜ | — |

As Fases 1–2 entregam valor sozinhas e **não exigem nenhuma mudança no Apps
Script**. Só a Fase 3 em diante mexe no que você mantém à mão. Isso é
deliberado: dá pra parar depois da Fase 2 se o custo das seguintes não se
justificar.

---

## 0.1. Resultados da Fase 0 (2026-09-09)

A pasta `CopyUtility` (`1Z_C-tlrGefckj8eWa50NFoAfVYmH-QMs`,
`samuel.ramos@airliquide.com`) já está compartilhada com o service account **como
Editor**. Isso permitiu rodar o diagnóstico inteiro de fora do Apps Script, pelo
Drive API — sem colar nada no editor. O que ele achou muda quatro pontos do plano.

### ✅ Resolvido: o gid do filtro existe e é a mesma aba

O medo da §3.6 não se confirma. `gid=1642735053` **é** a aba `SyncStatus` da
planilha de controle; `gid=0` retorna HTTP 400 (a aba original foi removida).
Os dois scripts apontam para a mesma aba, `_getFilterList()` funciona, e o
script 2 **não** está rodando sobre o portfólio inteiro. Uma fonte de verdade só.

### 🐞 Achado novo: a planilha de controle não tem linha de cabeçalho

`SyncStatus` do Control File começa direto no dado:

```
linha 1: PRJ0018861, DONE, 4,  6/11/2026, 11:18:14 AM
linha 2: PRJ0022813, DONE, 25, 9/9/2026, 3:32:09 PM
```

Mas `loadStatusMap()` (script 1) itera `for (let i = 1; i < data.length; i++)`,
tratando `data[0]` como cabeçalho. Consequência: **o projeto da linha 1 nunca
entra no `statusMap`**. Ele nunca conta como `DONE`, é reprocessado a cada
execução, e como `rowMap[project]` também não existe, `updateStatus()` cai no
`sheet.appendRow(...)` e **acrescenta uma linha duplicada toda vez**.

Hoje isso é latente: `PROJECT_NUMBERS` contém só `PRJ0022813`, então
`PRJ0018861` (linha 1) nunca é processado. **Deixa de ser latente exatamente na
Edição 1**, quando a fila passa a vir da planilha.

E invalida o `readQueue()` que este plano propunha: ele lia a partir da linha 2,
assumindo um cabeçalho que não existe — teria pulado `PRJ0018861` em silêncio.
Corrigido em §6.3.

Correção: **inserir a linha de cabeçalho** `Project | Status | Files Copied |
Last Updated | Error`. Conserta o off-by-one do script 1 sem tocar no código
dele, e o script 2 já é imune (`_getFilterList()` filtra `v !== "PROJECT"`).

### 🐞 Achado novo: colunas numéricas formatadas como data

Na planilha de limpeza (`1a0M…`), o export CSV devolve:

```
Project,Status,Files Processed,Labels Removed,Duplicates Deleted,Last Updated,Error
PRJ0018861,✅ Done,4,"12/31/1899, 12:00:00 AM",12/30/1899,9/9/2026,
PRJ0022813,✅ Done,25,"1/24/1900, 12:00:00 AM",12/30/1899,9/9/2026,
```

`Labels Removed` e `Duplicates Deleted` carregam **formatação de data**, então o
valor `1` vira `12/31/1899`, `25` vira `1/24/1900` e `0` vira `12/30/1899`. Os
valores brutos estão certos (o export XLSX mostra `1`, `25`, `0`) — o que está
errado é o formato da célula, e o CSV renderiza o formato.

Isso derruba uma premissa do plano: **`fetchSheetCsv()` não serve para ler o
upstream.** `sheets-engine.ts` usa o endpoint de export CSV, que aplica
formatação; a Fase 1 leria "12/31/1899 labels removidas". O `Last Updated`
também perde a hora (`9/9/2026` em vez de `9/9/2026 15:32:09`).

Correção: ler valores brutos em vez de formatados. A primeira ideia foi Sheets
API com `valueRenderOption: 'UNFORMATTED_VALUE'` — descartada logo em seguida,
porque a Sheets API não pode ser habilitada. Ver §0.2: o export XLSX resolve.

### ✅ Dissolvido: `toLocaleString()` não é o problema que eu supus

A §3.4 partia de que a data chegaria como string ambígua. Na prática o Google
Sheets **já converteu para valor de data real** (serial `46274.647…`), com
`timeZone: "Europe/Paris"` declarado no `appsscript.json`.
Lido como valor bruto (export XLSX, §0.2) chega o serial, sem ambiguidade nenhuma.

**Isso remove uma edição manual do Apps Script**: não é preciso trocar
`toLocaleString()` por `toISOString()`.

### ⛔ A Sheets API não pode ser habilitada — e por que isso melhora o desenho

**Confirmado com o usuário em 2026-09-09: não há como habilitar
`sheets.googleapis.com` no projeto GCP `1092014033242`.** É um projeto de ETL da
AL, e a permissão `serviceusage.services.enable` não está ao alcance.

Isso mataria o desenho original, que dependia de `values.append` para enfileirar.
Não mata — porque **o Drive API, que está habilitado, basta para os dois lados**,
e o caminho alternativo é mais limpo que o original.

**Leitura** — export XLSX via `drive.files.export` + o `xlsx` que já é
dependência. Devolve valores brutos, imune ao problema de formatação da §3.4.
Verificado nas duas planilhas.

**Escrita** — em vez de o Alumen escrever *na planilha*, ele escreve **um arquivo
de fila** na pasta `CopyUtility`, onde já tem Editor. O Apps Script lê esse
arquivo e faz o merge na própria planilha. Verificado ponta a ponta em
2026-09-09 com o service account:

```
CREATE ok → 1aBAWxXC5bmMYhlz1rVhK-GGCVf1W3XjY
UPDATE ok → 2026-09-09T21:53:09.038Z
READ   ok → { "queue": [ { "projectId": "PRJ_TESTE_ALUMEN_V2", … } ] }
DELETE ok — pasta limpa
```

Três coisas melhoram de verdade com essa virada, e não é só contorno:

1. **Some o escopo amplo.** A §3.2 se incomodava com `auth/spreadsheets`, que dá
   escrita em toda planilha compartilhada com o service account. Não é mais
   preciso: `auth/drive` sobre um arquivo que o próprio Alumen cria. O incômodo
   de segurança que estava em aberto na §8 desaparece.
2. **Some o contrato de colunas compartilhadas.** A §5 tinha que negociar "quem
   escreve na coluna A" e defender que `updateStatus()` só toca B..E. Agora a
   planilha tem **um único escritor** — o Apps Script — e o Alumen só lê. A
   corrida da §3.5 deixa de existir.
3. **Some a dependência de GCP.** Nada mais a habilitar, em nenhum projeto.

O custo é uma função a mais no Apps Script (`mergeAlumenQueue()`, §6.3) e um
arquivo JSON na pasta. Barato pelo que compra.

### ℹ️ O script 1 não está nessa pasta

A `CopyUtility` contém `Control File`, `Update Control File` e um único Apps
Script — `Remove Class`, que é o script 2 (fonte conferida: mesmas 12 funções e
as mesmas constantes; id `1AoWpu0dufbT3-lPvbLacxugHPHR89J2-8gRyrlYAx7r-I-quCGt0z-uM`).
O projeto do script 1 (`syncProjectFiles`) não é visível para o service
account. **As edições da §6.3 continuam sendo manuais suas** — não há como
alcançá-lo daqui.

### ⛔ Testado em 2026-09-10: mesmo o script 2, visível, não é editável por API

"Editor" numa pasta do Drive dá acesso ao **arquivo** do script (listar, mover,
renomear) — não ao **código**. Editar o código passa pela Apps Script API
(`script.googleapis.com`), uma API diferente da Drive API, que precisa estar
habilitada no projeto GCP.

Tentativa real com o service account, escopo
`script.projects.readonly`, contra o id acima:

```
Apps Script API has not been used in project 1092014033242 before or it is
disabled. Enable it by visiting
https://console.developers.google.com/apis/api/script.googleapis.com/...
```

`1092014033242` é o mesmo projeto (`al-bco-e9997-talend-etl-292614`) que já
bloqueia a Sheets API (§0.2) — é o projeto de ETL da AL, habilitar serviço novo
não está ao alcance do usuário. Mesma restrição, agora confirmada para uma
segunda API.

**Conclusão prática, sem ambiguidade:** não existe caminho por API para ler ou
escrever o código de nenhum dos dois scripts, mesmo o que está numa pasta com
Editor. **Toda a Fase 4 (§6.3) é manual, sem exceção.**

---

## 0.3. Resultados da Fase 1 (2026-09-09)

Implementada e implantada. **O teste da §10.1 passou**: `PRJ0018861` cleanup
volta `labelsRemoved: 1` e `duplicatesDeleted: 0` — valores brutos, o caminho
CSV não vazou. Rodado tanto num servidor descartável quanto em produção.

Arquivos: `src/lib/upstream-sync.ts` (novo), `db.ts` (as duas tabelas da §4),
`drive-panel-state.ts` (campo `upstream`), `api/admin/upstream-test/route.ts`
(novo) e o painel "Upstream (Apps Script)" em `admin/page.tsx`.

### O que o plano previu certo

- O export XLSX devolve valor bruto; o CSV mentiria (§3.4/§0.2). Confirmado.
- Ler no tick do SSE seria desastre (§3.3). O cache com timer próprio segurou:
  5 chamadas seguidas a `/api/drive/state` devolveram o mesmo `readAt`, sem
  ida ao Google.
- A planilha de controle não tem cabeçalho e a de limpeza tem (§0.1).
  Confirmado na leitura real.

### O que mudou em relação ao escrito

1. **Seleção de aba por nome, não por gid.** As duas planilhas guardam os dados
   numa aba chamada `SyncStatus` (a de limpeza tem também uma `Sheet2` vazia).
   Como o export XLSX traz o workbook inteiro, dá para escolher pelo nome — e
   aí some a ambiguidade de gid da §4 (a tabela listava `1642735053` como
   `upstream_cleanup_gid`, mas a §0.1 diz que esse gid é da planilha de
   **controle**). As chaves `upstream_control_gid`/`upstream_cleanup_gid`
   **não são mais necessárias** e não foram criadas.

2. **A detecção de cabeçalho é dinâmica, não fixa.** O óbvio seria "controle não
   tem cabeçalho, limpeza tem". Mas a §0.1 recomenda que você **acrescente** o
   cabeçalho na de controle — e no dia que isso acontecer, um leitor com a
   regra fixa passaria a engolir `PRJ0018861` em silêncio, que é exatamente o
   bug que a §0.1 descreve no script 1. O leitor testa se a primeira célula
   casa com o padrão de id de projeto e decide linha a linha. Funciona antes e
   depois da sua edição, sem release no meio.

3. **`sheet_at` é hora de Paris, e fica explícito.** O serial `46274.649` lê
   `15:34` se interpretado como UTC, mas o `modifiedTime` do Drive do mesmo
   arquivo é `13:35Z` — 2h de diferença, o offset CEST. O campo é gravado
   **sem sufixo de fuso** e documentado como relógio de parede da planilha;
   `observed_at` é o campo comparável. Carimbar `Z` teria criado timestamps
   errados por 2h com cara de certos.

4. **Vocabulário de status normalizado.** O script 1 escreve `DONE`, o script 2
   escreve `✅ Done`. Ambos viram `DONE`; o texto original fica em
   `detail.raw`. Estado desconhecido vira `UNKNOWN`, nunca é coagido para
   `DONE` — assim um status novo que você acrescentar aparece como si mesmo em
   vez de sumir.

### Comportamento a saber

- O timer de 15 s **começa preguiçoso**, na primeira vez que alguém abre o
  painel, e daí segue pelo resto da vida do processo (~8 chamadas/min ao
  Drive, irrelevante perto da cota). Não para quando ninguém está olhando.
  Se algum dia incomodar, o lugar de mexer é `getUpstreamSnapshot()`.
- **A primeira pintura depois de um deploy vem do espelho no SQLite**, marcada
  `stale: true` e `readAt: null`, até a primeira leitura fresca chegar (~1 s).
  Verificado reiniciando o processo. Falha de leitura mantém as últimas linhas
  boas e expõe `upstream.error` — nunca derruba o `buildDrivePanelState()`.

---

## 0.4. Resultados da Fase 2 (2026-09-09)

Implementada e implantada. `src/components/DataFlowLive.tsx` substitui o
`<iframe src="/dataflow.html">`; o arquivo estático foi apagado no mesmo
commit. Duas visões: **Cadeia** (as 6 etapas com contador ao vivo) e
**Projetos** (tabela PRJ × 6 etapas, busca + filtro "só ERROR").

### 🐞 Achado durante o teste com usuário básico — corrigido antes de implantar

O primeiro desenho reaproveitava `useDrivePanelStream()` (o hook de
`DriveView.tsx`, que consome `/api/drive/stream` e `/api/drive/state`). Esses
dois caminhos estão sob `/api/drive`, que o `middleware.ts` protege
**por inteiro** para admin — de propósito, porque o Drive Sync é admin-only
(`PLAN_USER_MANAGEMENT.md`). Testando com um usuário básico real: a Cadeia
chegava sempre zerada, sem nenhum erro visível — exatamente o tipo de falha
silenciosa que o §10 deste documento pede pra testar antes de considerar algo
pronto.

Corrigido com uma rota nova, **`/api/strom/dataflow-state`**, que chama o mesmo
`buildDrivePanelState()` mas devolve só `{upstream, counts, pipelineRunning}` —
não o objeto inteiro, que carrega detalhe operacional do Drive Sync
(`watchRoots`, `syncAll`, `recentRuns`) irrelevante pra quem só está olhando a
cadeia. Fica sob `/api/strom`, que não é protegido por `middleware.ts` — a
mesma família de `/api/strom/stats`, já aberta. `DataFlowLive.tsx` faz polling
próprio de 15 s (o mesmo TTL do cache do upstream) em vez de assinar o SSE do
Drive Sync.

Consequência boa: a tabela "Projetos" (`/api/strom/dataflow-projects`, criada
na mesma leva) segue o mesmo princípio — também fora de `/api/drive`, também
sem exigir admin.

Validado com um usuário básico real antes de implantar: `dataflow-state` e
`dataflow-projects` voltam 200 com dado de verdade; `/api/drive/state` continua
403 pro mesmo usuário — o Drive Sync não vazou.

### ℹ️ 305 projetos na tabela "Projetos", 66 no resto do Alumen — esperado

`/api/strom/dataflow-projects` consulta `SELECT DISTINCT project_id FROM
projects` (a tabela crua) e devolve 305 linhas. `/api/projects` — o que
Details/Impact/Graph mostram — devolve 66, porque passa por
`fetchProjectSummariesForViews()`, que dedupe e filtra pela visão curada do
portfólio (mesma função cuja lógica de "DDS atual" já tinha corrigido um bug
na Fase 3 de `PLAN_USER_MANAGEMENT.md`).

Não é bug: pra uma tela de diagnóstico de pipeline, ver os 305 — incluindo
entradas que nunca passaram de "descoberto" — é mais útil do que ver só os 66
que chegaram à visão curada. Registrado aqui pra não parecer inconsistência
da próxima vez que alguém comparar os dois números.

---

## 1. O que existe hoje

### 1.1 Fora do Alumen — os dois scripts

| | Script 1 — `syncProjectFiles` | Script 2 — `removeClassification*` |
|---|---|---|
| Roda como | seu usuário (Apps Script) | seu usuário |
| Faz | busca `name contains 'PRJnnn'` em todos os drives, copia para `BASE_FOLDER_ID/<PRJ>` | deduplica por nome + remove Drive Labels, recursivo |
| Lista de trabalho | `PROJECT_NUMBERS`, **array hardcoded no código** | coluna A do Control File (`_getFilterList()`) |
| Estado publicado em | `1AG9…` aba `SyncStatus` | `1a0M…` gid `1642735053` |
| Retomada | auto-agenda trigger de 1 min até acabar, **depois se autodestrói** | trigger de 70 s + lock em ScriptProperties |

O ponto que destrava o plano inteiro: **os dois já publicam a própria telemetria
em planilha, keyed por número de projeto.** Não é preciso externalizar acesso
nenhum, nem abrir endpoint, nem dar credencial da AL para o Alumen. A planilha
já é a interface — só falta alguém do outro lado lendo.

### 1.2 Dentro do Alumen

| Peça | Onde | Estado |
|---|---|---|
| Leitura de planilha com o service account | `sheets-engine.ts:11` `fetchSheetCsv()` | ✅ existe, escopo `drive.readonly` |
| Estado unificado do pipeline | `drive-panel-state.ts:48` `buildDrivePanelState()` | ✅ existe |
| Push ao vivo para o browser | `api/drive/stream/route.ts` (SSE, tick 500 ms–2 s) | ✅ existe |
| Consumo no cliente | `DriveView.tsx:82` `new EventSource(...)` | ✅ existe |
| Página Data Flow | `public/dataflow.html`, embutida via `<iframe>` em `StromArchitecture/index.tsx:52` | ❌ HTML estático, zero dados |
| Escrita em Google | — | ❌ **não existe**; tudo é `drive.readonly` |

A infraestrutura de "ao vivo" já está pronta e em produção. O trabalho da Fase 2
é quase todo de UI: trocar um `<iframe>` de HTML estático por um componente que
lê o `DrivePanelState` que já chega pelo SSE.

### 1.3 A cadeia completa

```
[0] Fila / cópia        SyncStatus (1AG9…)              ← script 1   ⟵ novo no Alumen
[1] Dedup + labels      planilha de progresso (1a0M…)   ← script 2   ⟵ novo no Alumen
    ══════════ fronteira: pasta base 1IathIq6… ══════════
[2] Discover            auto-pipeline.ts:159   currentStage='discover'  ✅
[3] Download            auto-pipeline.ts:196   currentStage='download'  ✅
[4] Goals               auto-pipeline.ts:210   currentStage='goals'     ✅
[5] Impact              auto-pipeline.ts:222   currentStage='impact'    ✅
[6] Views               Goals · Graph · Matrix · Deep Dive             ✅
```

A chave de junção existe e é a mesma dos dois lados: os scripts usam
`PRJ0022813`; o Alumen normaliza com `normalizeProjectId()`
(`api/drive/sheet/route.ts:16` já faz esse casamento para a planilha do
portfólio). **Não é preciso inventar identificador novo.**

---

## 2. A ideia central: a planilha é a fronteira

```
 ambiente Air Liquide          fronteira            Alumen (EC2)
 ────────────────────          ─────────            ────────────
 Apps Script (seu usuário)  ─→  Control File  ←─   service account
   lê Drive corporativo         (planilha)          escreve 1 linha (fila)
   copia p/ pasta base                              lê status de volta
```

O Alumen **nunca** toca no Drive corporativo. Ele escreve uma linha numa
planilha e lê status. Todo o acesso privilegiado continua onde já está: no seu
usuário, dentro do Apps Script. Isso não é um contorno — é a separação correta,
e é o que torna a Fase 3 defensável perante quem cuida de segurança na AL.

---

## 3. As armadilhas

Esta é a parte que decide se isso funciona ou se funciona *quase sempre*.

### 3.1 O worker se autodestrói — a mais importante

Script 1, ao terminar a fila:

```js
else { deleteExistingTriggers(); Logger.log('🎉 All projects completed! Triggers removed.'); }
```

Depois disso **não existe nada rodando**. Se o Alumen escrever um PRJ novo na
planilha, ele fica lá parado para sempre, e a tela mostra `⏳ Enfileirado`
indefinidamente — indistinguível de "está demorando".

Sem resolver isso, a Fase 3 entrega um botão que não faz nada. É por isso que a
Fase 4 (worker permanente) não é opcional se a Fase 3 for feita: **as duas andam
juntas ou nenhuma vale a pena.**

A correção é um segundo trigger, **com nome de handler diferente**, que sobreviva
ao `deleteExistingTriggers()`. Detalhe fácil de errar: aquela função apaga por
nome de handler —

```js
if (t.getHandlerFunction() === TRIGGER_FUNCTION) ScriptApp.deleteTrigger(t);
```

— então um heartbeat chamado `syncHeartbeat` sobrevive, e um chamado
`syncProjectFiles` seria apagado pelo próprio script na primeira vez que a fila
esvaziasse. Silenciosamente. §6.3 leva isso em conta.

### 3.2 Escrever exige escopo novo — mas bem menor do que o plano supunha

**Reescrita depois da Fase 0 (§0.2).**

Hoje **todo** acesso Google do Alumen é `drive.readonly`
(`drive-engine.ts:94`, `sheets-engine.ts:14`). Para escrever o arquivo de fila
basta subir para `https://www.googleapis.com/auth/drive` e usar
`drive.files.create` / `files.update` — o `googleapis` já está no projeto
(v171.4.0), e a permissão de Editor na pasta `CopyUtility` já existe.

Decisão de engenharia mantida: **um cliente separado** (`drive-writer.ts`) para
a escrita, em vez de subir o escopo dos clientes existentes. Assim todo o resto
do app continua incapaz de escrever em qualquer lugar, por construção e não por
disciplina.

O incômodo que a versão anterior deste plano registrava — `auth/spreadsheets`
dando escrita em toda planilha compartilhada com o service account — **deixa de
existir**. `auth/drive` também é amplo, mas o alvo agora é um arquivo que o
próprio Alumen cria e do qual é dono, não uma planilha de produção que outra
coisa também escreve.

Se a revisão da AL quiser apertar mais, o mínimo real é: Editor **só** na pasta
que hospeda o arquivo de fila, Leitor nas duas planilhas. Hoje o service account
tem Editor na `CopyUtility` inteira — mais do que o necessário.

### 3.3 O Alumen leria a planilha 120×/minuto

O SSE hoje tica a cada 500 ms–2 s (`api/drive/stream/route.ts:11-13`). Se o
`buildDrivePanelState()` passar a ler as planilhas a cada tick, são ~120
chamadas/minuto por **cada aba aberta** — estoura cota do Google e adiciona
centenas de ms de latência a um tick que hoje é uma query SQLite local.

O upstream precisa de cadência própria: um cache em memória com TTL de ~15 s,
atualizado por um `setInterval` **do lado do servidor**, independente dos ticks
do SSE. Os ticks leem o cache. Como os scripts ciclam a cada 60–70 s, 15 s já dá
sensação de tempo real com folga.

### 3.4 O export CSV mente — leia valores não formatados

**Reescrita depois da Fase 0 (§0.1).** A preocupação original era com
`toLocaleString()` produzindo string ambígua. Não é o caso: o Sheets já converte
para valor de data real, e o `appsscript.json` declara `Europe/Paris`.

O problema real é outro e é pior, porque é silencioso: o endpoint de export CSV
que `sheets-engine.ts:31` usa aplica a **formatação da célula**. Na planilha de
limpeza, `Labels Removed` e `Duplicates Deleted` estão formatadas como data, e o
CSV devolve `12/31/1899` onde o valor é `1`. Um parser bem-comportado lê isso
como texto válido e grava lixo, sem erro nenhum.

Portanto o upstream **não** pode ser lido por `fetchSheetCsv()`. Como a Sheets
API não pode ser habilitada (§0.2), o caminho é um só:

**`drive.files.export` com mimeType XLSX + parse com o `xlsx`** que já é
dependência (`excel-parser.ts`). Devolve valores brutos — `1`, `25`, `0` e o
serial de data íntegro — e não exige habilitar nada. Verificado nas duas
planilhas (18.984 e 9.712 bytes).

O custo é ler a planilha inteira a cada poll em vez de um range. Com ~1.000
linhas e poll de 15 s (§3.3) isso é irrelevante; se um dia crescer, o cache de
15 s continua sendo a proteção real.

`observed_at` continua sendo a data confiável; a coluna do script é complemento.

### 3.5 Corrida entre o append do Alumen e o `appendRow` do script

Cenário: o Alumen faz `values.append` na coluna A no mesmo instante em que
`updateStatus()` faz `sheet.appendRow(...)` para um projeto novo.

Analisando o que cada um faz, o risco é baixo:

- `updateStatus()` só escreve `getRange(row, 2, 1, 4)` — **colunas B..E** — para
  linhas que já existem. Não desloca nada.
- Como o append só acrescenta no fim, os índices em `sheet._rowMap`
  (`loadStatusMap`, script 1) continuam válidos para as linhas já mapeadas.
- `values.append` do lado do Google resolve o fim da tabela no momento da
  escrita, no servidor.

A consequência real da corrida é benigna: duas linhas para o mesmo PRJ. O
`loadStatusMap` mantém a última (`map[project]` sobrescreve), então uma fica
órfã e visualmente confusa — não perde trabalho.

Mesmo assim, `LockService.getScriptLock()` em volta das escritas do script 1 é
barato e elimina a classe inteira. E o Alumen deve deduplicar por `project_id`
ao ler, ficando com a linha de status mais avançado.

**Propriedade útil, e é bom não quebrar:** como `updateStatus()` escreve apenas
B..E, colunas novas (`F: Requested By`, `G: Queued At`) são **invisíveis para o
script atual** — dá para adicioná-las sem tocar em uma linha de Apps Script.

### 3.6 ✅ RESOLVIDO na Fase 0 — mas leia, porque a análise segue valendo

**Verificado em 2026-09-09 (§0.1): `gid=1642735053` é a aba `SyncStatus` da
planilha de controle. Os dois scripts apontam para a mesma aba. Nada a fazer.**
O texto abaixo fica como registro do raciocínio e porque descreve um modo de
falha que volta se alguém renomear ou recriar a aba.



Script 2 lê a lista de filtro assim:

```js
const FILTER_SHEET_ID  = "1AG9e9ihBBE6rfGGUPEQBwobKSE7ql63MxK8AviGr-JQ";
const FILTER_SHEET_GID = 1642735053;
const sheet = ss.getSheets().find(s => s.getSheetId() === FILTER_SHEET_GID);
if (!sheet || sheet.getLastRow() === 0) return null;
```

Script 1 pega a aba **por nome**: `ss.getSheetByName('SyncStatus')`, criando-a se
não existir.

São a mesma aba? Ninguém sabe olhando só o código. E note que `1642735053`
aparece como GID em **duas planilhas diferentes** (é também o `SHEET_GID` da
planilha de progresso `1a0M…`) — cheiro forte de copy-paste.

Isso importa muito, e não só para o plano: se aquele GID **não existir** na
`1AG9…`, o `.find()` devolve `undefined`, `_getFilterList()` retorna `null`, e o
script 2 cai no ramo "sem lista de filtro: processando **TODAS** as pastas" —
apagando duplicatas e labels no portfólio inteiro a cada execução, em silêncio.
Pode já estar acontecendo hoje.

É a primeira coisa a verificar (§6.1), antes de qualquer código.

### 3.7 Riscos que já existem e o plano só torna visíveis

Não são causados por este trabalho, mas passam a aparecer numa tela que as
pessoas vão acreditar:

- **Dedup por nome apaga arquivo legítimo.** Script 1 deduplica por `srcId`;
  dois arquivos *diferentes* com o mesmo nome (`Gate Note.pdf` vindo de duas
  pastas de origem) chegam ambos ao destino. Script 2 vê "mesmo nome na mesma
  pasta" e apaga um com `Drive.Files.remove()` — **permanente, não vai para a
  lixeira**. A origem está intacta, mas o Alumen nunca vê aquele documento.
  A tela vai mostrar "Duplicatas deletadas: 3" como se fosse sucesso.
- **Projeto grande fica preso em ERROR.** Se `_processFolder` estoura o
  orçamento de 4,5 min ele lança; a pasta é marcada `❌ Error` e o
  `state.projectIndex++` roda **mesmo assim**. Não há retomada dentro da pasta:
  uma pasta que não cabe numa janela nunca completa, em nenhuma execução.
- **Ping-pong entre os dois scripts.** Rodar o script 1 depois do 2 recopia o
  que o 2 apagou (o `srcId` sumiu junto com a cópia), e o 2 apaga de novo.

Nenhum é escopo deste plano. Mas a Fase 5 deve mostrar contadores de duplicatas
apagadas com destaque suficiente para que o primeiro seja notado, e tratar
`ERROR` como estado **acionável** (com botão de retry), não como estado final.

### 3.8 A linha 1 da planilha de controle é comida como se fosse cabeçalho

Achado na Fase 0 — detalhamento e evidência em §0.1. Em resumo: `SyncStatus` não
tem cabeçalho, `loadStatusMap()` pula `data[0]`, e o projeto da linha 1 fica
invisível para o mapa de status — reprocessado e duplicado a cada execução.

É latente hoje só porque `PROJECT_NUMBERS` não inclui aquele projeto. **A
Edição 1 o torna ativo**, porque é ela que faz a fila vir da planilha. Por isso
a inserção do cabeçalho (§6.2) tem de vir *antes* da Edição 1, e não depois.

---

## 4. Modelo de dados

Uma tabela nova, seguindo o padrão de `db.ts` (`CREATE TABLE IF NOT EXISTS`
dentro do bloco de init, migrações aditivas em `try/catch`):

```sql
-- Espelho local do que as planilhas do Apps Script dizem. Fonte da verdade é a
-- planilha; isto é cache + histórico, para que a tela mostre transições mesmo
-- quando a linha é sobrescrita lá.
CREATE TABLE IF NOT EXISTS upstream_status (
  project_id   TEXT NOT NULL,
  stage        TEXT NOT NULL,          -- 'copy' | 'cleanup'
  status       TEXT NOT NULL,          -- QUEUED|IN_PROGRESS|DONE|ERROR
  detail_json  TEXT NOT NULL DEFAULT '{}',
  sheet_at     TEXT,                   -- 'Last Updated' da planilha, se parseável (§3.4)
  observed_at  TEXT NOT NULL,          -- quando o Alumen leu — sempre confiável
  PRIMARY KEY (project_id, stage)
);

-- Só as transições, para a timeline por projeto.
CREATE TABLE IF NOT EXISTS upstream_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  stage       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_events_project ON upstream_events(project_id, id);
```

`detail_json` guarda o resto das colunas sem exigir migração a cada coluna nova
que você acrescentar no Apps Script: `{filesCopied, filesProcessed,
labelsRemoved, duplicatesDeleted, error}`.

Config em `app_settings` (tabela já existe, `db.ts:214`), editável pela tela de
admin em vez de hardcoded:

| key | valor |
|---|---|
| `upstream_control_sheet_id` | `1AG9e9ihBBE6rfGGUPEQBwobKSE7ql63MxK8AviGr-JQ` |
| `upstream_control_gid` | a confirmar em §6.1 |
| `upstream_cleanup_sheet_id` | `1a0M4Xue8NbrPfPbrJJdpJ1MjHTtx_7QsYTIPTruCo_Q` |
| `upstream_cleanup_gid` | `1642735053` |
| `upstream_poll_seconds` | `15` |

---

## 5. O contrato

**Reescrito depois da Fase 0 (§0.2).** A versão anterior negociava colunas
compartilhadas dentro da planilha. Não é mais preciso: agora há **um escritor por
artefato**, o que é a propriedade que torna isto fácil de raciocinar.

| Artefato | Escrito por | Lido por |
|---|---|---|
| `CopyUtility/_alumen_queue.json` | **só o Alumen** | Apps Script |
| Control File `1AG9…` aba `SyncStatus` | **só o Apps Script** | Alumen (XLSX) |
| Planilha de limpeza `1a0M…` | **só o Apps Script** | Alumen (XLSX) |
| `CopyUtility/_alumen_heartbeat.json` | **só o Apps Script** | Alumen |

### 5.1 O arquivo de fila

`_alumen_queue.json`, na pasta `CopyUtility`. O Alumen reescreve o arquivo
inteiro a cada enfileiramento (não faz append — last-writer-wins é suficiente,
porque só ele escreve):

```json
{
  "version": 1,
  "updatedAt": "2026-09-09T21:53:09.038Z",
  "queue": [
    { "projectId": "PRJ0022813", "requestedBy": "samuel.ramos@airliquide.com",
      "queuedAt": "2026-09-09T21:50:00.000Z" }
  ]
}
```

O Apps Script lê, faz merge dos `projectId` que ainda não estão na planilha, e
**não apaga o arquivo** — quem decide remover um item é o Alumen, depois de ver
o projeto aparecer na `SyncStatus`. Assim uma execução perdida não perde pedido.

Campo `version` para que uma mudança futura de formato seja detectável em vez de
silenciosa: o Apps Script ignora o que não souber ler e loga.

### 5.2 A planilha

Estrutura da `SyncStatus` do Control File, agora com o cabeçalho que a §3.8
manda inserir. O Alumen **só lê** — valida o cabeçalho e recusa explicitamente
("cabeçalho inesperado na coluna D") em vez de parsear errado:

| Col | Cabeçalho |
|---|---|
| A | `Project` |
| B | `Status` |
| C | `Files Copied` |
| D | `Last Updated` |
| E | `Error` |

### 5.3 O heartbeat

`_alumen_heartbeat.json`, mesma pasta, escrito pelo Apps Script a cada execução
do worker — inclusive quando não há nada a fazer:

```json
{ "at": "2026-09-09T21:53:09.038Z", "pending": 0 }
```

Ficou como arquivo, não como aba da planilha, pelo mesmo motivo do resto: um
escritor por artefato, e nada de mexer na planilha por razão que não seja o
trabalho dela. Sem isso o Alumen não distingue "worker vivo e ocioso" de "worker
morto", e a fila passa a mentir (§3.1).

---

## 6. Suas ações manuais

Esta é a seção que você pediu. Ordem importa: **§6.1 antes de qualquer código**,
porque uma das verificações pode mudar o desenho e outra pode revelar um bug
ativo hoje.

### 6.1 Fase 0 — ✅ JÁ FEITA, não precisa fazer nada

Como a pasta `CopyUtility` já estava compartilhada com o service account como
Editor, o diagnóstico rodou de fora, pelo Drive API. **Resultados em §0.1.** Não
é preciso colar nada no editor do Apps Script.

O script abaixo fica como registro — é o que teria sido rodado à mão, e continua
útil se um dia o compartilhamento for revogado:

<details>
<summary><code>alumenDiagnostico()</code> — versão Apps Script (não precisa rodar)</summary>

```js
function alumenDiagnostico() {
  const CONTROL = '1AG9e9ihBBE6rfGGUPEQBwobKSE7ql63MxK8AviGr-JQ';
  const CLEANUP = '1a0M4Xue8NbrPfPbrJJdpJ1MjHTtx_7QsYTIPTruCo_Q';

  [['CONTROL', CONTROL], ['CLEANUP', CLEANUP]].forEach(([label, id]) => {
    const ss = SpreadsheetApp.openById(id);
    Logger.log(`\n=== ${label} — ${ss.getName()} ===`);
    ss.getSheets().forEach(s => {
      Logger.log(`  aba "${s.getName()}"  gid=${s.getSheetId()}  linhas=${s.getLastRow()}`);
    });
  });

  // A pergunta da §3.6: o gid do filtro existe na planilha de controle?
  const ctrl = SpreadsheetApp.openById(CONTROL);
  const filtro = ctrl.getSheets().find(s => s.getSheetId() === 1642735053);
  Logger.log(`\n1642735053 existe no CONTROL? ${filtro ? 'SIM → aba "' + filtro.getName() + '"' : 'NÃO — script 2 está rodando em TUDO (§3.6)'}`);

  const sync = ctrl.getSheetByName('SyncStatus');
  Logger.log(`Aba "SyncStatus" existe? ${sync ? 'SIM, gid=' + sync.getSheetId() : 'NÃO'}`);
  if (sync && filtro) {
    Logger.log(`São a MESMA aba? ${sync.getSheetId() === filtro.getSheetId() ? 'SIM ✅' : 'NÃO ⚠️ — duas fontes de verdade'}`);
  }
  if (sync && sync.getLastRow() > 0) {
    Logger.log(`Cabeçalho SyncStatus: ${JSON.stringify(sync.getRange(1, 1, 1, 7).getValues()[0])}`);
  }

  Logger.log(`\nFuso do script: ${Session.getScriptTimeZone()}`);
  Logger.log(`toLocaleString() aqui produz: "${new Date().toLocaleString()}"  (§3.4)`);
}
```

</details>

### 6.2 Compartilhamento e pré-requisitos

**✅ Já feito** — a pasta `CopyUtility` está compartilhada com
`al-bco-e9997-talend-etl@al-bco-e9997-talend-etl-292614.iam.gserviceaccount.com`
como **Editor**, e as duas planilhas herdam isso (`canEdit: true` conferido nas
duas). Não há passo de Leitor→Editor a fazer: a Fase 3 já está destravada do
ponto de vista de permissão.

> Nota de segurança, já que veio de graça: o service account tem escrita nas duas
> planilhas **e na pasta**. Mais do que este plano precisa. Se a revisão da AL
> apertar, o mínimo necessário é Editor só no `Control File` e Leitor no resto.

**⛔ Habilitar a Sheets API: descartado.** Confirmado com o usuário em
2026-09-09 que não há como (§0.2). O plano foi redesenhado para não precisar
dela — nenhuma ação de GCP é necessária, em nenhuma fase.

Como consequência, as duas correções de planilha **não podem ser feitas pelo
service account** (editar célula e formato só existe na Sheets API). Elas passam
para o Apps Script, onde você já tem tudo. Rodar uma vez cada:

```js
// (A) Insere o cabeçalho que falta na SyncStatus do Control File.
//     Conserta o off-by-one da §3.8 sem tocar no resto do script 1.
//     Rode com nenhum dos dois scripts em execução.
function alumenInserirCabecalho() {
  const ss = SpreadsheetApp.openById('1AG9e9ihBBE6rfGGUPEQBwobKSE7ql63MxK8AviGr-JQ');
  const sh = ss.getSheets().find(s => s.getSheetId() === 1642735053);
  const primeira = String(sh.getRange(1, 1).getValue() || '').trim().toUpperCase();
  if (primeira === 'PROJECT') { Logger.log('já tem cabeçalho — nada a fazer'); return; }
  sh.insertRowBefore(1);
  sh.getRange(1, 1, 1, 5)
    .setValues([['Project', 'Status', 'Files Copied', 'Last Updated', 'Error']])
    .setFontWeight('bold');
  sh.setFrozenRows(1);
  Logger.log('✅ cabeçalho inserido; linhas de dados agora: ' + (sh.getLastRow() - 1));
}

// (B) Colunas D e E da planilha de limpeza estão formatadas como Data,
//     então 1 aparece como 12/31/1899 e 0 como 12/30/1899 (§3.4).
//     Só o formato muda; os valores já estão certos.
function alumenCorrigirFormato() {
  const ss = SpreadsheetApp.openById('1a0M4Xue8NbrPfPbrJJdpJ1MjHTtx_7QsYTIPTruCo_Q');
  const sh = ss.getSheetByName('SyncStatus');
  const n = Math.max(1, sh.getLastRow() - 1);
  sh.getRange(2, 4, n, 2).setNumberFormat('0');   // D:E
  Logger.log('✅ colunas D e E → número inteiro');
}
```

- [ ] Rodar `alumenInserirCabecalho()` — **antes** da Edição 1 (§3.8).
      Verificação: o log deve dizer `linhas de dados agora: 2`.
- [ ] Rodar `alumenCorrigirFormato()` — cosmético. Não bloqueia nada, porque a
      leitura por XLSX já pega valores brutos; mas hoje a planilha mente para
      quem a abre no navegador.

Ambas são reversíveis: apagar a linha 1 desfaz (A), e o formato de célula é dois
cliques no próprio Sheets.

### 6.3 Fase 4 — as edições no Apps Script

Só depois que as Fases 1–2 estiverem rodando e você tiver visto a tela ao vivo
com dados reais. Não há pressa: até aqui, nenhuma linha do que você mantém
mudou.

**Edição 1 — a fila vem da planilha, não do código.**

Substituir o array:

```js
// ❌ sai
const PROJECT_NUMBERS = ['PRJ0022813'];

// ✅ entra
function readQueue() {
  const sheet = getControlSheet();
  const last = sheet.getLastRow();
  if (last < 1) return [];
  // Lê a partir da linha 1, NÃO da 2: a planilha pode não ter cabeçalho
  // (§0.1/§3.8). O filtro por 'PROJECT' descarta o cabeçalho quando ele existe,
  // e nada quando não existe — as duas situações ficam corretas.
  const rows = sheet.getRange(1, 1, last, 2).getValues();
  const seen = new Set();
  const out = [];
  for (const [rawId, rawStatus] of rows) {
    const id = String(rawId || '').trim().toUpperCase();
    if (!id || id === 'PROJECT') continue;
    if (seen.has(id)) continue;          // §3.5: fica com a primeira ocorrência
    seen.add(id);
    out.push({ id, status: String(rawStatus || '').trim().toUpperCase() });
  }
  return out;
}
```

> ⚠️ A versão anterior deste plano lia a partir da linha 2. Com a planilha real,
> que não tem cabeçalho, isso teria pulado `PRJ0018861` em silêncio. É o tipo de
> erro que a Fase 0 existe para pegar.

E em `syncProjectFiles()`, trocar `const projects = [...new Set(PROJECT_NUMBERS)]`
por `const projects = readQueue().map(r => r.id)`.

O resto da função — `statusMap`, `TIME_LIMIT_MS`, o auto-resume — **fica como
está**. Ela já pula `DONE` e `ERROR`, que é exatamente o comportamento que a
fila precisa.

**Edição 1b — ler o arquivo de fila do Alumen.** Nova, criada pela virada da
§0.2. É o que substitui o `values.append` que o plano original faria do lado do
Alumen:

```js
const ALUMEN_FOLDER_ID = '1Z_C-tlrGefckj8eWa50NFoAfVYmH-QMs';  // CopyUtility
const ALUMEN_QUEUE_NAME = '_alumen_queue.json';

// Lê os pedidos que o Alumen deixou e acrescenta à SyncStatus os que ainda não
// estão lá. NÃO apaga o arquivo: quem remove um item é o Alumen, depois de ver
// o projeto aparecer na planilha (§5.1) — assim uma execução perdida não perde
// pedido.
function mergeAlumenQueue() {
  const pasta = DriveApp.getFolderById(ALUMEN_FOLDER_ID);
  const it = pasta.getFilesByName(ALUMEN_QUEUE_NAME);
  if (!it.hasNext()) return 0;

  let payload;
  try {
    payload = JSON.parse(it.next().getBlob().getDataAsString());
  } catch (e) {
    Logger.log('⚠️ fila do Alumen ilegível: ' + e.message);
    return 0;
  }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.queue)) {
    Logger.log('⚠️ formato de fila desconhecido (version=' + (payload && payload.version) + ') — ignorando');
    return 0;
  }

  const sheet = getControlSheet();
  const existentes = new Set(readQueue().map(r => r.id));
  let novos = 0;
  for (const item of payload.queue) {
    const id = String(item && item.projectId || '').trim().toUpperCase();
    if (!id || existentes.has(id)) continue;
    sheet.appendRow([id, '', 0, new Date(), '']);
    existentes.add(id);
    novos++;
    Logger.log('  + enfileirado pelo Alumen: ' + id + ' (por ' + (item.requestedBy || '?') + ')');
  }
  return novos;
}
```

**Edição 2 — o worker permanente.** Função nova, nome de handler novo (§3.1):

```js
const HEARTBEAT_FUNCTION  = 'syncHeartbeat';   // ≠ TRIGGER_FUNCTION, de propósito
const HEARTBEAT_FILE_NAME = '_alumen_heartbeat.json';

function syncHeartbeat() {
  // 1. Puxa o que o Alumen pediu desde o último ciclo (Edição 1b).
  const novos = mergeAlumenQueue();
  if (novos) Logger.log(`${novos} projeto(s) novo(s) vindos do Alumen.`);

  // 2. Sempre publica o heartbeat, inclusive ocioso — é assim que o Alumen
  //    distingue "vivo e sem trabalho" de "morto" (§3.1, §5.3).
  const pendentes = readQueue().filter(r => r.status !== 'DONE' && r.status !== 'ERROR');
  writeHeartbeat(pendentes.length);
  if (pendentes.length === 0) return;                 // ocioso: sai barato

  // 3. Já existe execução em curso? Não empilha.
  const jaRodando = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === TRIGGER_FUNCTION);
  if (jaRodando) { Logger.log('Já há um ciclo agendado — heartbeat não faz nada.'); return; }

  Logger.log(`Heartbeat: ${pendentes.length} pendente(s) — iniciando ciclo.`);
  syncProjectFiles();
}

function writeHeartbeat(pendentes) {
  const conteudo = JSON.stringify({ at: new Date().toISOString(), pending: pendentes });
  const pasta = DriveApp.getFolderById(ALUMEN_FOLDER_ID);
  const it = pasta.getFilesByName(HEARTBEAT_FILE_NAME);
  if (it.hasNext()) it.next().setContent(conteudo);
  else pasta.createFile(HEARTBEAT_FILE_NAME, conteudo, MimeType.PLAIN_TEXT);
}
```

**Edição 3 — instalar o trigger permanente.** Rodar **uma vez**, à mão:

```js
function instalarHeartbeat() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === HEARTBEAT_FUNCTION)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(HEARTBEAT_FUNCTION).timeBased().everyMinutes(10).create();
  Logger.log('✅ Heartbeat instalado — a cada 10 min.');
}
```

> ⚠️ **Não** chame o handler de `syncProjectFiles`. `deleteExistingTriggers()`
> apaga por nome de handler, e o próprio script destruiria o heartbeat na
> primeira vez que a fila esvaziasse — sem erro nenhum no log (§3.1).

**~~Edição 4 — datas em ISO.~~ Cancelada pela Fase 0.** O Sheets já grava valor
de data real, não string; lido como valor bruto chega o serial sem ambiguidade
(§3.4). Uma edição manual a menos.

**Edição 5 (opcional) — lock no script 1.** Envolver as escritas de
`updateStatus()` em `LockService.getScriptLock()`, como o script 2 já faz por
ScriptProperties. Elimina a classe da §3.5. Barato.

### 6.4 Checklist de validação — cada passo isolado

Fazer nesta ordem, confirmando cada um antes do próximo. Se algo quebrar, você
sabe exatamente o quê:

| # | Passo | Como saber que deu certo |
|---|---|---|
| ~~1~~ | ~~Diagnóstico~~ | ✅ feito — §0.1 |
| ~~2~~ | ~~Compartilhar as planilhas~~ | ✅ já estava (Editor na pasta) |
| ~~3~~ | ~~Habilitar a Sheets API~~ | ⛔ descartado — plano redesenhado sem ela (§0.2) |
| 4 | `alumenInserirCabecalho()` | log diz `linhas de dados agora: 2` |
| 5 | Fase 1–2 no Alumen | Data Flow mostra `PRJ0018861` e `PRJ0022813` com status real |
| 6 | Fase 3 — escrita do arquivo de fila | `_alumen_queue.json` aparece na `CopyUtility` com o PRJ pedido |
| 7 | Edições 1 + 1b (fila da planilha + merge) | `mergeAlumenQueue()` à mão: a linha nova aparece na `SyncStatus` |
| 8 | Edições 2–3 (heartbeat) | `_alumen_heartbeat.json` atualiza sozinho em ≤10 min |
| 9 | Ponta a ponta | Adicionar um PRJ pela UI → `IN_PROGRESS` em ≤10 min sem tocar em nada |

O passo 7 é o único com risco de regressão no que já funciona — e tem um
teste preciso, graças à Fase 0: os dois projetos da planilha estão `DONE`, então
o esperado é o script **pular os dois e não copiar nada**. Se ele copiar
`PRJ0018861`, o cabeçalho do passo 4 não foi aplicado corretamente (§3.8).

### 6.5 Como voltar atrás

| Se... | Fazer |
|---|---|
| A escrita do Alumen causar problema | Control File: Editor → Leitor. O append passa a 403; a leitura e o resto do pipeline seguem intactos. |
| O heartbeat rodar demais / atrapalhar | `ScriptApp.getProjectTriggers()` → apagar o de `syncHeartbeat`. Volta ao comportamento manual de hoje. |
| A Edição 1 der errado | Reverter para o array. Mantenha a versão antiga salva no histórico do editor (Apps Script guarda versões, mas salve uma cópia do arquivo antes por segurança). |

Nenhuma edição apaga dado. A pior falha realista é o worker não acordar — a fila
fica parada e visível na tela, que é bem melhor do que hoje.

---

## 7. Fases do lado do Alumen

### Fase 1 — leitura (nenhuma mudança no Apps Script) — ✅ done, ver §0.3

> ⚠️ O item abaixo ficou **desatualizado** e foi corrigido na execução: dizia
> `fetchSheetCsv()`, que é justamente a armadilha da §10.1. O implementado usa
> export XLSX via Drive API. Mantido aqui só para o registro.

- ~~`src/lib/upstream-sync.ts`: lê as duas planilhas com `fetchSheetCsv()` (já
  existe)~~ → **export XLSX** (§0.2/§0.3), normaliza com
  `normalizeProjectId()`, faz upsert em `upstream_status`, grava transições em
  `upstream_events`.
- Cache em memória, TTL 15 s, `setInterval` próprio — **não** no tick do SSE
  (§3.3). Falha de leitura não pode derrubar o `buildDrivePanelState()`: mantém
  o último valor bom e expõe `upstream.error`.
- `db.ts`: as duas tabelas da §4.
- `drive-panel-state.ts`: campo `upstream` no `DrivePanelState` — o SSE e o
  `DriveView` passam a recebê-lo sem nenhuma mudança neles.
- Admin: botão "Testar upstream" que mostra o erro cru do Google (o 403 de
  `sheets-engine.ts:36` já traz o email a compartilhar).

### Fase 2 — Data Flow ao vivo

- `src/components/DataFlowLive.tsx` substitui o `<iframe src="/dataflow.html">`
  em `StromArchitecture/index.tsx:52`.
- Mantém o desenho das 6 etapas do `dataflow.html` (é bom, e as pessoas já o
  reconhecem), mas cada nó ganha contador ao vivo e cada projeto em trânsito
  vira uma linha.
- Duas visões: **cadeia** (o diagrama, com contadores por etapa) e **projetos**
  (tabela `PRJ × 6 etapas`, filtrável, com destaque para `ERROR`).
- Etapas 2–5 vêm do `state.pipeline` que já chega; 0–1 do `state.upstream`.
- `public/dataflow.html` sai do ar quando a Fase 2 entrar. Vale apagar no mesmo
  commit para não ficarem duas verdades.

### Fase 3 — escrita (arquivo de fila, não planilha)

- `src/lib/drive-writer.ts`: cliente separado, escopo `auth/drive` (§3.2).
  Escreve `_alumen_queue.json` na pasta `CopyUtility` — `files.create` na
  primeira vez, `files.update` depois. Reescreve o arquivo inteiro; não faz
  append (§5.1).
- `POST /api/drive/queue` — `{ projectId }`. Já cai sob `/api/drive` em
  `PROTECTED_PREFIXES` (`middleware.ts:38`), portanto **admin-only por
  herança**; mesmo assim chamar `requireAdmin()` no handler (`auth.ts:39`),
  seguindo o padrão do resto.
- Valida com `normalizeProjectId()`, rejeita o que já está na fila ou já tem
  status na planilha, grava `requestedBy` = email da sessão e `queuedAt` = ISO.
- **Remoção da fila é do Alumen**, não do script: quando um `projectId` aparece
  na `SyncStatus`, o próximo write tira o item do JSON. Assim uma execução
  perdida do worker não perde pedido (§5.1).
- UI: campo + botão na DriveView e na própria Data Flow. Estado otimista
  (`⏳ Enfileirado`) até a leitura da planilha confirmar.

### Fase 4 — worker permanente

As edições da §6.3, feitas por você. Do lado do Alumen só entra a leitura de
`_alumen_heartbeat.json` e o aviso "worker offline há X min" quando o campo
`at` passar de ~25 min (2,5× o intervalo).

### Fase 5 — acabamento

- `ERROR` vira acionável: botão "Reenfileirar" que limpa B–E daquela linha
  (equivalente ao `resetErrors()` do script, mas por projeto e pela tela).
- Contador de duplicatas apagadas com destaque — §3.7, primeiro item.
- Timeline por projeto a partir de `upstream_events`.
- ETA honesto na fila: "próximo ciclo em ~N min", derivado do heartbeat.

---

## 8. Decisões tomadas

**Polling, não Web App.** Publicar o Apps Script como Web App e o Alumen dar um
POST tiraria a latência de até 10 min. Mas abre um endpoint HTTP no ambiente AL
— exatamente o que se quer evitar, e o que tornaria a conversa com segurança
difícil. O custo do polling é uma espera que dá para *mostrar* na tela ("na
fila, próximo ciclo em ~7 min"), e espera visível incomoda muito menos que
espera silenciosa.

**Heartbeat de 10 min, não de 1.** Um trigger de 1 min são ~1.440
execuções/dia queimando cota do Apps Script quase sempre à toa. 10 min é o
equilíbrio; quando há trabalho, o auto-resume de 1 min do próprio script assume
e a fila anda rápido. O heartbeat só precisa ser rápido o suficiente para
*acordar*, não para processar.

**Planilha como fonte da verdade, SQLite como cache.** O Alumen nunca "corrige"
a planilha a não ser pelo append da fila. Se as duas divergirem, a planilha
ganha. Isso mantém o Apps Script funcionando sozinho se o Alumen estiver fora do
ar — que é a propriedade que torna a Fase 3 segura de tentar.

**Fases 1–2 entregam sozinhas.** Se a escrita não passar na revisão de segurança
da AL, ou se o worker permanente se mostrar frágil, a página ao vivo continua de
pé e útil. Nada na Fase 1–2 depende de nada da Fase 3–4.

---

## 9. Em aberto

- [x] ~~As três respostas da §6.1~~ — respondidas em §0.1 (2026-09-09).
- [x] ~~Habilitar a Sheets API~~ — **impossível**, confirmado em 2026-09-09.
      Plano redesenhado para não precisar dela (§0.2). Nenhuma ação de GCP
      pendente, em nenhuma fase.
- [ ] Rodar `alumenInserirCabecalho()` e `alumenCorrigirFormato()` no Apps
      Script (§6.2) — as duas correções de planilha que o service account não
      alcança.
- [ ] O `drive_watch_roots` local só tem uma raiz `initiatives`
      (`1e8pLQRpTdmtWNpQ7lqWzqguBC__Q2Tye`). Em produção o Alumen aponta para a
      pasta base `1IathIq6…` do script 1? Se não, as etapas 1 e 2 da cadeia não
      se conectam de fato e o diagrama mentiria.
- [ ] Service account único com escopo `spreadsheets` amplo, ou um segundo SA só
      para a fila? (§3.2) — decisão de segurança, não técnica.
- [ ] Quem pode enfileirar: só admin, ou basic também? Hoje `/api/drive` inteiro
      é admin-only. Enfileirar é ação barata e reversível; se a ideia é que o
      time de governança use, talvez valha um escopo próprio.
- [ ] Os riscos da §3.7 (dedup destrutivo, projeto preso em ERROR) merecem
      correção própria, fora deste plano. Vale abrir um `PLAN_` separado?

---

## 10. Controle de execução — qual modelo em cada parte

Mesmo critério da `PLAN_USER_MANAGEMENT.md` §9, em ordem de peso: **o erro é
barulhento ou silencioso?** Depois: existe molde no repo? A tarefa é desenho
novo ou aplicação de desenho já decidido?

Vale a mesma verificação que sustenta aquela tabela: `tsconfig.json:8` tem
`"strict": true` e `npm run build` roda typecheck + lint, então boa parte dos
erros aqui é barulhenta.

| Parte | Modelo | Por quê |
|---|---|---|
| **Fase 1** — leitor upstream (XLSX → `upstream_status`/`upstream_events` → `DrivePanelState`) | Sonnet **+ o teste da §10.1** | Moldes fortes (`sheets-engine.ts:11` para auth, `excel-parser.ts` para xlsx, `db.ts:31` para tabelas). Mas é o **único ponto deste plano com falha silenciosa real** — ver §10.1 |
| **Fase 2** — `DataFlowLive.tsx` | Sonnet | Maior volume, menor risco. `DriveView.tsx:82` já é o molde do consumidor de SSE. Erro de UI aparece na tela |
| **Fase 3** — `drive-writer.ts` + `POST /api/drive/queue` | Sonnet | Dois arquivos pequenos. `requireAdmin()` (`auth.ts:39`) é padrão copiável. 403/500 são barulhentos |
| **Fase 4** — edições no Apps Script | — | Humano. O código já está escrito na §6.3 |
| **Fase 5** — acabamento | Sonnet | Incremental sobre o que a Fase 2 deixou |

**Resumo:** tudo Sonnet. Opus só se **outra premissa cair** — o valor da sessão
de 2026-09-09 não foi escrever código, foi derrubar quatro premissas (§0.1,
§0.2). Executar o plano não precisa disso; redesenhá-lo, sim.

### 10.1 A armadilha silenciosa da Fase 1

`fetchSheetCsv()` (`sheets-engine.ts:11`) existe, parece exatamente a ferramenta
certa, e **funciona**: devolve 200, o CSV parseia, o build passa, o TypeScript
não reclama, a tela mostra um número plausível. Só que o número é `12/31/1899`
onde o valor é `1` (§3.4).

Qualquer modelo que chegue nessa fase sem ler §0.1/§0.2 vai alcançar essa
função. É a escolha óbvia e está errada. O que protege não é o modelo — é o
teste:

> Depois de implementar o leitor, imprimir os valores parseados de `PRJ0018861`
> e conferir `labelsRemoved === 1` e `duplicatesDeleted === 0`.
> Se aparecer data, o caminho CSV vazou.

Isso converte a falha silenciosa em barulhenta, que é a régua do §9.

### 10.2 Como rodar o Sonnet bem aqui

- **Passar §0.1 e §0.2 junto com a fase.** São elas que registram as premissas
  já derrubadas. Sem isso o modelo re-deriva as erradas — e as erradas são as
  que parecem certas.
- **Uma fase por sessão.** Não emendar Fase 1 em Fase 2 no mesmo contexto.
- **Usar os `file:line` deste documento como entrada**, não pedir para
  redescobrir. Já estão verificados.
- **`npm run build` ao fim de cada fase** — é o que converte esquecimento em
  erro visível.
- **Nunca aceitar "o código roda" como prova na Fase 1.** A prova é o valor
  (§10.1).
