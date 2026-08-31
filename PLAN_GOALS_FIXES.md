# Plano: Correções do Goals Extractor

Auditoria de `goals-analyzer.ts` (752 linhas), `goals-extractor.ts`,
`goals-scanner.ts`, `DEFAULT_GOALS_PROMPT` e `/api/goals`. Diferente da
auditoria do Impact, aqui quase tudo pôde ser **medido** contra os 61 goals
reais do banco, não só inferido do código.

Companheiro de [PLAN_IMPACT_FIXES.md](PLAN_IMPACT_FIXES.md).

## Saúde atual (medido 2026-08-31)

O extractor **funciona**. Rendimento sobre 61 goals com `status='success'`:

| Campo | Preenchidos |
|---|---|
| summary_one_line | 59/61 |
| security_impacts | 57/61 |
| out_of_scope | 58/61 |
| digital_technologies / gio_sl_dds_impacts | 56/61 |
| dds_entities_touched | 55/61 |
| impact_claims | 54/61 |
| timeline_struct (com algum dado) | 47/61 |
| tech_tags / vendors | 46 / 44 |
| gio_services_touched | 40/61 |
| mentioned_projects | 17/61 |
| project_relations | 11/61 |

Nenhum campo sai sempre vazio, e todas as 61 linhas estão em
`prompt_version=4` (a atual). Os problemas abaixo são de **ciclo de vida** e de
**validação de referências**, não de qualidade da extração.

## Achados

| # | Severidade | Onde | Problema | Status |
|---|---|---|---|---|
| 1 | 🔴 Alta | `goals-analyzer.ts:353`, `:637` | Documentos novos nunca disparam re-análise | ✅ **feito** |
| 2 | 🔴 Alta | `tech-catalog.ts:162`, `goals-analyzer.ts:144` | Referências malformadas viram nós-fantasma no grafo | ✅ **feito** |
| 3 | 🔴 Alta | `tech-catalog.ts:160` | Placeholder de template (`PRJ00XXXX`) extraído como projeto | ✅ **feito** |
| 4 | 🔴 Alta | `goals-analyzer.ts:718` | `resetGoalsData` não limpa os campos das Ondas 2/3 | ✅ **feito** |
| 5 | 🟡 Média | `goals-scanner.ts:75` vs `impact-engine.ts` | PGM meio-suportado: scanner aceita, análise descarta | ✅ **feito** |
| 6 | 🟡 Média | `goals-analyzer.ts:357` | `successCount` conta linhas `error`/`partial` como sucesso | ✅ **feito** |
| 7 | 🟡 Média | `goals-analyzer.ts:103` | JSON quebrado indistinguível de extração vazia | ✅ **feito** |
| 8 | 🟡 Média | `goals-analyzer.ts:66` | Estado do run só em memória (mesmo bug já corrigido no Impact) | ✅ **feito** |
| 9 | 🟢 Baixa | `goals-extractor.ts:95` | Penalidades do ranking de arquivos quase nunca aplicam | ✅ **feito** |
| 10 | 🟢 Baixa | `goals-extractor.ts:6` | `MAX_TEXT_LENGTH` de 80k chars é muito conservador | ✅ **feito** |
| 11 | 🟢 Baixa | `goals-analyzer.ts:610` | Sequencial com sleep fixo de 1,5s | ✅ **feito** |
| 12 | 🟢 Baixa | `GoalsView.tsx` | Campos das Ondas 2/3 nunca são exibidos | ✅ **feito** |
| 13 | 🟢 Baixa | ingestão | 12 `project_id` malformados vindos da planilha | ✅ **feito** |

## Lotes

| Lote | Itens | Risco | Delegável? |
|---|---|---|---|
| **A** ✅ | ~~#3, #4, #6, #7, #9~~ — concluído | Baixo | Sim — mecânico, spec fechado |
| **B** ✅ | ~~#1~~ — concluído | **Alto** | Armadilha 1.3 confirmada e evitada; ver 1.5 |
| **C** ✅ | ~~#2, #5, #13~~ — concluído | Médio | Decisão de 2.4 tomada pelo usuário |
| **D** ✅ | ~~#8, #11~~ — concluído | Baixo | Sim — independentes |
| **E** ✅ | ~~#10, #12~~ — concluído | Baixo | Decisão de produto, tomada por medição |

---

## Lote B — #1: documentos novos não re-analisam

### 1.1 Diagnóstico

Duas condições de skip em `analyzeProject`:

```js
// condição 1
if (existing?.status === 'success' && versionOk) { runStatus.successCount++; return; }
// condição 2
if (existing && existing.source_files === filesJson && versionOk) { runStatus.successCount++; return; }
```

O comentário logo acima afirma:

> *Both checks fail (i.e. we run) when: — the prompt was bumped — **new files were
> synced** — the active language differs*

**A condição 1 não compara `source_files`.** Um projeto com `status='success'` na
versão de prompt atual é pulado para sempre, independentemente de quantos
documentos novos cheguem.

### 1.2 O agravante que anula também a condição 2

`getGoalsList` (`goals-analyzer.ts:637`) faz auto-sync a cada carregamento da
aba Goals:

```sql
ON CONFLICT(project_id, output_language) DO UPDATE SET
  source_files = excluded.source_files
```

Atualiza `source_files` **sem re-analisar**. Só de abrir a aba, o sinal de "os
arquivos mudaram" é apagado. Então mesmo corrigindo a condição 1, a comparação
já chega comprometida.

Consistente com o medido: `source_files` do DB bate com o disco em **61/61**
projetos — mas isso não prova que nada mudou, só que o auto-sync passou por lá.

### 1.3 ⚠️ Armadilha: o fix ingênuo pode custar caro

`source_files` é `JSON.stringify(project.files)`, um array **ordenado de caminhos
absolutos** produzido por `collectFiles` via `readdirSync`. Comparar essa string
crua é frágil:

- a ordem do `readdirSync` não é garantida entre sistemas de arquivos;
- qualquer mudança de caminho (renomear a pasta raiz, mover `data/drive`) muda
  todas as strings;
- um falso "mudou" re-analisa **tudo**.

Com 301 projetos, um falso positivo geral significa 301 chamadas de LLM — acima
do cap diário de 500 já contando o resto. **Não commitar o fix sem pensar no
custo do falso positivo.**

### 1.4 Tarefas

- [x] `fileSignature()` em `goals-scanner.ts`: caminhos **relativos**, ordenados,
      + `size` de cada arquivo, em sha256. Nova coluna `source_signature`.
- [x] As duas condições viraram uma só, com o mesmo critério.
- [x] O auto-sync de `getGoalsList` virou `DO NOTHING` — um caminho de leitura
      não deve mutar proveniência.
- [x] Dry-run executado ANTES de ligar (ver 1.5).
- [x] Comentário das condições reescrito para descrever o que o código faz.

**Decisão de design: `size`, não `mtime`.** O `mtime` muda quando o sync do
Drive rebaixa um arquivo idêntico, o que dispararia re-análise de tudo a cada
sync. Testado: reescrever conteúdo idêntico mantém a assinatura; editar mudando
tamanho, adicionar e remover arquivo mudam. O buraco conhecido é uma edição que
não muda a contagem de bytes — preço aceitável por não re-analisar o portfólio
inteiro a cada re-sync.

### 1.5 Dry-run: a armadilha era real e foi evitada

Adicionar a coluna deixaria todas as 61 linhas com assinatura vazia. Se isso
contasse como "mudou", seriam 61 chamadas de LLM só para descobrir impressões
digitais que já sabíamos. Por isso o **backfill preguiçoso**: linha antiga com
assinatura vazia recebe a assinatura calculada e é pulada, sem LLM.

Medido antes de ligar:

```
projetos escaneados em data/drive: 61
  backfill da assinatura (SEM LLM): 61
  já batem, pulados               : 0
  RE-ANALISARIAM (custo de LLM)   : 0
assinatura estável contra ordem dos arquivos: SIM
```

---

## Lote C — referências entre projetos

### 2.1 Diagnóstico (#2)

Medição das 23 referências distintas extraídas (`mentioned_projects` +
`project_relations`), normalizando **os dois lados** (`PRJ|PGM|PROG` + dígitos
sem zeros à esquerda, repadded a 7):

```
batem exatamente            :  5
MESMO projeto, só formato   :  4
realmente desconhecidas     : 14
```

Os 4 recuperáveis por normalização:

```
PRJ0001395  ==  PRJ001395
PRJ0009991  ==  PRJ009991
PRJ17301    ==  PRJ0017301
PRJ00XXXX   ==  PRJ00xxxxx     ← os dois são lixo, ver #3 e #13
```

Ou seja: normalizar padding quase dobra as referências válidas (5 → 9).

### 2.2 A consequência já está no banco

`PRJ0019030` **não existe** em `projects` nem em `project_goals`, mas é alvo de
**4 linhas** em `projects_impact`. É literalmente o *"phantom project satellite"*
que os comentários do `impact-engine.ts` descrevem como coisa a evitar —
acontecendo em produção.

O caminho: `normalizeImpactTarget` exige só `/^PRJ\d{4,}$/`, então qualquer id
com 4+ dígitos passa, exista ou não.

### 2.3 #5 — PGM meio-suportado

| Camada | Aceita PGM? |
|---|---|
| `goals-scanner.ts:75` (`PRJ_FOLDER_NAME`) | ✅ `(?:PRJ\|PGM)` |
| `tech-catalog.ts:160` (`PRJ_MENTION_REGEX`) | ❌ só PRJ |
| `goals-analyzer.ts:144` (`sanitizeProjectRelations`) | ❌ só PRJ |
| `impact-engine.ts` (`normalizeImpactSource/Target`) | ❌ só PRJ |

Há **9 projetos PGM** em `projects` hoje, e **0** com goals (nenhum tem pasta no
Drive ainda). No dia em que um PGM ganhar pasta: os goals são extraídos
normalmente, as claims GIO/DDS são materializadas (usam `rec.projectId` direto,
sem normalizar) — mas **todas as arestas projeto↔projeto dele são descartadas em
silêncio**, porque `normalizeImpactSource` devolve `''` e a linha cai.

### 2.4 ⚠️ Decisão pendente — não delegar

O que fazer com as **14 referências genuinamente desconhecidas** (projetos
citados em documentos que não estão na planilha CDIO)?

| Opção | Efeito |
|---|---|
| Descartar | Grafo limpo, mas perde sinal real — o documento *de fato* cita aquele projeto |
| Manter e marcar como não-resolvida | Preserva o sinal, exige a UI distinguir nó real de citação órfã |
| Criar stub em `projects` | Resolve o grafo, mas polui a tabela de portfólio com projetos que não são do portfólio |

- [x] **Decidido pelo usuário: manter e marcar como não-resolvida.**
- [x] Criado `src/lib/project-id.ts` com `normalizeProjectId` / `extractProjectIds`
      / `sameProject`, aplicado em `tech-catalog`, `goals-analyzer`,
      `impact-engine` e `excel-parser`. 16 casos de teste, todos tirados dos
      dados reais, passando.
- [x] `PGM` e `PROG` normalizados em todas as camadas.
- [x] Arestas para projetos fora do portfólio recebem `targetResolved: false`,
      resolvido em **tempo de leitura** (`loadPortfolioIds`) — `projects` é
      reconstruída a cada upload, então uma referência órfã hoje pode virar
      válida amanhã sem que a linha de impacto mude.

### 2.5 Efeito medido

```
referências distintas         : 23
  válidas (eram 5)            : 8
  órfãs, agora MARCADAS       : 14
  lixo descartado (PRJ00XXXX) : 1

arestas de impacto
  targetResolved=true  : 178
  targetResolved=false : 19   (antes: nós-fantasma indistinguíveis)
```

Confirmado via `/api/impact`: 128 impactos agregados, 11 marcados como fora do
portfólio — incluindo o `PRJ0020505 -> PRJ0019030` que abriu esta investigação.

---

## Lote A — mecânico

### A.1 — #3 Exigir dígitos suficientes numa menção

`PRJ_MENTION_REGEX = /PRJ[\s\-_]*([0-9]+)([A-Z]{0,4})/gi` não tem mínimo de
dígitos, então leu o placeholder de template `PRJ00XXXX` como número `00` +
sufixo `XXXX`. Medido:

```
dígitos nas menções extraídas: {"2": 3, "5": 1, "7": 20, "8": 1}
  suspeito: PRJ00XXXX (3x)
```

5 das 25 menções têm contagem de dígitos fora do canônico (7).

- [ ] Exigir no mínimo 4 dígitos no regex (`[0-9]{4,}`), alinhando com o
      `PROJECT_ID_RE` que o `impact-engine` já usa
- [ ] Rejeitar sufixos que sejam repetição de `X` (padrão clássico de
      placeholder em template de documento)

### A.2 — #4 `resetGoalsData` incompleto

Limpa os campos livres e os 6 arrays originais, mas **não** limpa
`project_relations`, `out_of_scope`, `impact_claims` nem `timeline_struct` —
justamente os mais densos, adicionados nas Ondas 2 e 3.

Parcialmente mascarado (o Impact filtra `status='success'` e o reset marca
`pending`), mas a função promete algo que não cumpre, e um reset seguido de
inspeção da aba mostra dados velhos.

- [ ] Adicionar os 4 campos ao `UPDATE`
- [ ] Considerar derivar a lista de colunas de um único lugar, para o próximo
      campo novo não ser esquecido de novo

### A.3 — #6 `successCount` conta erro como sucesso

A condição 2 de skip dispara para linhas com `status` `'error'` ou `'partial'` e
mesmo assim faz `runStatus.successCount++`. A UI reporta falha como sucesso.

- [ ] Contabilizar conforme o `status` real da linha existente (skipped/error/
      partial em contadores próprios, ou ao menos não como sucesso)

### A.4 — #7 JSON quebrado vira "partial" silencioso

`parseGoalsResponse` devolve `{}` no `catch`, então uma resposta malformada do
LLM produz `hasData === false` → `status='partial'` com `error_message` vazio,
indistinguível de "os documentos não tinham nada". O `raw_gemini_response` é
gravado, então é recuperável, mas o usuário não tem como saber.

- [ ] Diferenciar falha de parse de extração vazia: gravar `status='error'` com
      mensagem explícita quando o JSON não puder ser lido

### A.5 — #9 Penalidades do ranking não aplicam

`scoreFile` retorna no **primeiro** padrão que casa, e as penalidades
(`meeting|minutes|notes` = 20, `draft|wip` = 15) são as últimas da lista. Então
`Architecture_Meeting_Minutes.docx` pontua 78 por casar com `architecture` e
nunca chega na penalidade. As penalidades só valem para arquivos que não casam
com mais nada — o comentário diz que elas *"push low-signal docs past the budget
last"*, o que não acontece.

- [ ] Aplicar penalidade como **modificador**, não como regra alternativa: casar
      o melhor padrão positivo e depois subtrair se o nome também casar com um
      padrão de baixo sinal

---

## Lote D — infraestrutura

### D.1 — #8 Persistir o estado do run

Mesmo problema já resolvido no Impact: `runStatus` (`goals-analyzer.ts:66`) vive
só em memória e morre com o processo. Um OOM (já observado nesta máquina) ou um
deploy perde o run sem deixar rastro.

- [x] Tabela `goals_runs`, progresso gravado a cada projeto. O reclaim de órfãos
      virou `reclaimOrphanedRuns`, cobrindo `impact_runs` e `goals_runs`.
- [x] `lastRun` no status + aviso âmbar na aba Goals.

Testado com o cenário do OOM: linha `running` órfã (23/61) → reload → `aborted`
com `finished_at`, progresso preservado, e `lastRun` na API. Linha removida.

Nota de convenção: `auto_runs` usa heal preguiçoso com carência de 30 min
(`drive-panel-state`), enquanto `impact_runs`/`goals_runs` usam reclaim no boot.
Os dois estão documentados; o do boot é mais imediato mas assume um único
processo escritor.

### D.2 — #11 Paralelizar

`await new Promise(r => setTimeout(r, 1500))` entre projetos, sequencial. Os 61
projetos levaram ~1h de relógio. Com 301 vira o gargalo do pipeline.

- [x] `p-limit` com `GOALS_CONCURRENCY` (default **3**, via
      `STROM_GOALS_CONCURRENCY`). O sleep fixo de 1,5s foi removido.

**Por que 3 e não 10** (o `drive-engine` usa 10 para downloads): cada slot
segura uma extração de texto em memória — buffer do arquivo + até
`MAX_TEXT_LENGTH` de texto parseado de .docx/.pdf — e esta máquina tem 3,7 GB
de RAM com histórico de OOM killer derrubando o servidor. Download é I/O;
extração é CPU e memória.

---

## Lote E — decisões de produto

### E.1 — #10 Rever o teto de contexto

`MAX_TEXT_LENGTH = 80000` chars (~20k tokens), comentado como *"Gemini pro
context budget per project"*. O modelo em uso (`gemini-3.1-pro-preview`) tem
contexto de ordem de 1M tokens. Toda a máquina de ranking + truncamento de
`goals-extractor.ts` existe por causa desse teto.

- [x] Medido, extraindo o texto real dos 61 projetos:

```
estouram o teto de 80k : 11 de 61 (18%)
texto total            : 2.900.588 chars
o LLM via              : 2.230.130 (76,9%)
DESCARTADO             :   670.458 chars (23%)

maiores:  PRJ0020336  225.843 chars  -> cortava 145.843 (65% do material)
          PRJ0010712  215.623 chars  -> cortava 135.623
          PRJ0018921  208.888 chars  -> cortava 128.888
mediana: 33.383  |  p90: 120.816
```

`PRJ0010712` é o projeto que a análise de impacto mostra conectando a 4 outros
— e estava perdendo 63% da sua documentação.

- [x] Novo teto: **300.000** chars (~75k tokens), via `STROM_GOALS_MAX_CHARS`.
      Cobre todo o portfólio atual com folga e é confortável para um modelo de
      1M tokens. A mediana (33k) não é afetada; só os 11 grandes mudam.

⚠️ **Só vale para extrações NOVAS.** A assinatura de arquivos não muda ao subir
o teto, então os 11 projetos truncados não re-rodam sozinhos. Os 240 projetos
ainda sem goals já nascem com o teto novo. Para reprocessar os 11 existentes é
preciso forçar (bump de `GOALS_PROMPT_VERSION` ou re-run individual) — decisão
de custo, não tomada aqui.

### E.2 — #12 Exibir os campos das Ondas 2/3

`impact_claims`, `project_relations`, `out_of_scope` e `timeline_struct` são
extraídos, validados, gravados e consumidos pelo Impact — mas `GoalsView.tsx`
não renderiza nenhum deles. A saída mais densa e mais auditável do extractor é
invisível para quem usa a aba.

- [x] Os 4 campos renderizados em seções próprias, cada item com a
      `evidence_quote` verbatim e o arquivo de origem — que é o que permite
      auditar se a claim é real. Severidade e `confidence: inferred` destacados.
- [x] `ProjectGoals` (server) também não declarava esses campos, apesar de o
      `SELECT *` retorná-los. Corrigido.

Confirmado via API que os dados chegam: impact_claims 54/61, out_of_scope 58/61,
timeline_struct 61/61, project_relations 11/61.

### E.3 — #13 Normalizar IDs na ingestão

12 `project_id` malformados vindos da planilha CDIO:

```
"PRJ0011825 -"                  "X1_6896"        "FR_7346"     "CA_9532"
"PRJ code to be created"        "N/A"            "US_8042B"    "Contract Note"
"PRJ009991"  "PRJ001395"  "PRJ002077"           "PGM0001197 (was PROG0019070)"
```

Três categorias distintas: sujeira de digitação (`"PRJ0011825 -"`), placeholders
de processo (`"N/A"`, `"PRJ code to be created"`) e ids de outro esquema
(`X1_6896`, `FR_7346`). É a outra metade do #2 — normalizar só o lado das
referências não resolve se a tabela `projects` também está torta.

- [ ] Normalizar/trim no `excel-parser` e sinalizar os não-normalizáveis para
      revisão humana, em vez de gravá-los silenciosamente

---

## Verificação

- [x] `npx tsc --noEmit` limpo
- [x] `npm run lint` sem novos problemas nos arquivos editados
- [x] Rotas `/api/goals`, `/api/impact` e `/api/projects` em 200
- [x] **Antes de qualquer run de LLM:** dry-run do #1 — 61 backfills, 0
      re-análises (ver 1.5)
- [x] Depois do Lote C: referências válidas subiram de 5/23 para 8/23 (a 9ª era
      lixo dos dois lados e é corretamente descartada agora)

## Log

<!-- Formato: `AAAA-MM-DD` — item — o que foi feito. Append no fim. -->

- `2026-08-31` — Auditoria inicial. 13 achados, nenhum corrigido ainda.
  Diferente da auditoria do Impact (onde todos os bugs eram latentes), aqui há
  **dois com efeito já visível nos dados**: `PRJ0019030` é alvo de 4 linhas de
  impacto sem existir em lugar nenhum (#2), e `PRJ00XXXX` foi extraído 3 vezes
  como projeto (#3). O rendimento da extração em si está saudável.
- `2026-08-31` — **Lotes A, B e C concluídos (9 dos 13 achados).** Criado
  `src/lib/project-id.ts` como fonte única para identidade de projeto, que era a
  raiz comum de #2, #3, #5 e #13 — a regra estava reimplementada em 7 lugares com
  resultados divergentes. Detecção de mudança de documentos passou a usar
  `source_signature` com backfill preguiçoso: o dry-run exigido em 1.3 mostrou 61
  backfills e **0 re-análises**, então ligar a correção custou zero LLM.
  Referências órfãs agora marcadas (`targetResolved`) em vez de virarem
  nós-fantasma, conforme decisão do usuário.
- `2026-08-31` — **Restam #8, #10, #11, #12** (Lotes D e E). Nenhum é bug de
  correção: são journal do run, teto de contexto, paralelismo e exibição na UI.
- `2026-08-31` — **Lotes D e E concluídos — os 13 achados estão fechados.**
  `goals_runs` + reclaim unificado (#8); `p-limit` com concorrência 3, escolhida
  pela memória da máquina e não pelo throughput (#11); teto de contexto de 80k
  para 300k, decidido medindo os 23% de texto que estavam sendo descartados
  (#10); campos das Ondas 2/3 exibidos com evidência verbatim (#12).
  **Pendência de custo, não de código:** o teto novo só afeta extrações novas;
  os 11 projetos hoje truncados precisam de um re-run forçado para se
  beneficiar.
