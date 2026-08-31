# Plano: Correções da Análise de Impacto

Auditoria completa do pipeline de impacto (`impact-engine.ts` 1330 linhas,
`impact-narrative.ts`, 6 rotas em `/api/impact`, `prompts.ts`, schema).
Achados confirmados por leitura de código + teste isolado do JOIN.

## Achados (2026-08-31)

| # | Severidade | Onde | Problema | Status |
|---|---|---|---|---|
| 1 | 🔴 Alta | `impact-engine.ts:16-37`, `:553-568` | Prompt repete o mesmo bloco de goals K vezes (fan-out goals×projects) | ✅ **feito** (2026-08-31) |
| 2 | 🔴 Alta | `impact-engine.ts:437`, `:584-587` | Cobertura de pares mentirosa: batcher marca par coberto, prompt descarta o projeto | ✅ **feito** (2026-08-31) |
| 3 | 🔴 Alta | `impact-engine.ts:1022`, `db.ts:120` | Comentário desatualizado: materialização não sobrescreve mais linhas do LLM | ✅ **feito** (2026-08-31) |
| 4 | 🟡 Média | `impact-engine.ts:893` | "Validação" de target é no-op (ternário com ramos idênticos) | ✅ **feito** (2026-08-31) |
| 5 | 🟡 Média | `impact-narrative.ts:54-65` | `DIRECTION_VERBS` incompleto + 3 vocabulários de `direction` divergentes | ✅ **feito** (2026-08-31) |
| 6 | 🟡 Média | `impact-engine.ts:375-453` | Custo LLM O(N²) + teto de 200 batches trunca cobertura em silêncio | ✅ **feito** (2026-08-31) — ver ressalva em 6.2.2 |
| 7 | 🟡 Média | `impact-engine.ts:39` | `analysisStatus` só em memória — run morre sem rastro (visto: OOM kill) | ✅ **feito** (2026-08-31) |
| 8 | 🟢 Baixa | `impact-engine.ts:571` | N+1: `getProjectDocuments` traz `content_text` inteiro por projeto por batch | ✅ **feito** (2026-08-31) |
| 9 | 🟢 Baixa | `impact-engine.ts:941` | `rematerializeClaimsForLanguage` exportada e nunca usada | ✅ **feito** (2026-08-31) |

## Lotes de execução

| Lote | Itens | Risco | Delegável? |
|---|---|---|---|
| **A** ✅ | ~~#3, #4, #5, #9~~ — concluído | Baixo | Sim — mecânico, spec fechado |
| **B** | #1 | Médio | Sim — **desde que respeite a armadilha da seção 1.3** |
| **C** ✅ | ~~#2, #6~~ — concluído | Alto | Critério do filtro decidido por medição, não por palpite |
| **D** ✅ | ~~#7, #8~~ — concluído | Baixo | Sim — independente dos demais |

---

## Lote A — mecânico

### A.1 — #3 Descartar pseudo-targets vindos do LLM

**Contexto.** `materializeClaimsAsImpacts` gera as linhas `GIO_SERVICES` /
`DDS_IMPACTS` de forma determinística a partir de `project_goals.impact_claims`.
O comentário em `impact-engine.ts:1022` afirma que o `INSERT OR REPLACE` em
`(source, target, impact_type, lang)` faz essas linhas sobrescreverem qualquer
equivalente emitido pelo LLM. **Isso não é mais verdade**: a UNIQUE foi alargada
(`db.ts:120`) para incluir `gio_services, dds_entities`. Uma linha do LLM com
lista de entidades diferente não colide → sobrevive como duplicata fantasma.

Hoje a única defesa é o prompt pedindo "não emita essas linhas"
(`prompts.ts:181-188` e `:212-213`) — exatamente o tipo de obediência que
motivou abandonar o LLM nesse caminho.

- [x] Em `parseImpactResponse`, descartar toda linha cujo `target` normalizado
      seja `GIO_SERVICES` ou `DDS_IMPACTS`, com contador `droppedPseudo` no log.
      O descarte acontece **depois** da normalização de propósito: é isso que
      captura grafias corrompidas (`DDS_IMPAcripts`) em vez de deixá-las virar
      satélites-fantasma de projeto.
- [x] Corrigir o comentário em `runFullImpactAnalysis` para descrever o
      comportamento real da UNIQUE atual e apontar de onde vem a garantia agora.
- [x] Manter o texto do prompt como está (defesa em profundidade: prompt **e**
      parser).

**Cuidado.** Não mexer em `normalizeImpactTarget`. *(Correção ao texto original
deste plano: a justificativa que eu tinha escrito estava errada — as linhas
materializadas **não** passam por `parseImpactResponse`, elas chamam
`storeImpacts` direto. O motivo real de manter a função é outro: o fuzzy match
dela é o que detecta pseudo-targets corrompidos para poderem ser descartados.)*

Verificado que a materialização não foi afetada: `parseImpactResponse` só é
chamada em `processBatch`; `storeImpacts` é chamada direto pelos dois caminhos
de materialização.

### A.1.1 ⚠️ Também latente — mas a defesa via prompt é frágil por construção

Auditoria das 197 linhas reais em `projects_impact` (140 pseudo-target):

```
compatíveis com materialização  : 140
só podem vir do LLM (direction) : 0
só podem vir do LLM (nº ents≠1) : 0
```

Zero fantasmas — nos 15 runs feitos até agora o modelo **obedeceu** a instrução
do prompt de não emitir essas linhas. Critério usado: `materializeClaimsAsImpacts`
sempre emite exatamente 1 entidade por linha e `direction` restrita a
`{provides_to, depends_on, requires_coordination}` (via `ROLE_TO_DIRECTION`);
qualquer coisa fora disso só poderia ter vindo do LLM.

O fix vale mesmo assim, porque a obediência do modelo era **load-bearing** e não
é confiável:

1. O prompt de impacto é **editável pelo usuário** em `/admin` (`savePrompts`
   grava `data/prompts.json`). Remover sem querer o parágrafo "DO NOT re-emit"
   reintroduz os fantasmas na hora. Hoje `data/prompts.json` não existe — está
   rodando o `DEFAULT_IMPACT_PROMPT`.
2. O modelo está fixado num **preview** (`gemini-3.1-pro-preview`). Já vimos
   `gemini-3-pro` e `gemini-2.5-pro` saírem do ar nesta conta; a próxima troca de
   modelo re-sorteia o grau de obediência.

Ou seja: o comentário do código prometia uma garantia de banco que não existia,
e a garantia real dependia de o LLM cooperar. Agora ela é estrutural.

### A.2 — #4 Validar target de verdade

`impact-engine.ts:893` tem os dois ramos do ternário idênticos:

```ts
const target = c.target_kind === 'gio' ? c.target : c.target;
```

O comentário promete validar contra o catálogo canônico e
`target-catalog.ts:200-206` documenta `isCanonicalTarget` como "used by validators
in impact-engine.ts" — mas o módulo nem é importado lá. A validação real só existe
no write path (`goals-analyzer.ts:236`). Consequência: `claimsDroppedBadTarget`
sempre reporta 0, e `target-catalog.data.json` é editável pelo admin.

- [x] Importar `isCanonicalTarget` de `./target-catalog` em `impact-engine.ts`.
- [x] Substituir o ternário por validação real; incrementar
      `claimsDroppedBadTarget` e `continue` quando o target não for canônico.

Auditadas as 140 `impact_claims` reais: **140/140 passam**, 0 seriam descartadas.
Nenhuma mudança de comportamento nos dados atuais, como esperado —
`sanitizeImpactClaims` já filtra na escrita. O valor do fix é o caso que o
comentário original alegava cobrir e não cobria: `impact_claims` é JSON que
sobrevive a mudanças de schema, e o catálogo por trás de `isCanonicalTarget` é
**editável em runtime** via `/admin/catalog` — um alvo canônico na hora da
gravação pode deixar de ser canônico depois.

### A.3 — #5 Unificar o vocabulário de `direction`

Três fontes divergentes hoje:

| Fonte | Valores |
|---|---|
| `prompts.ts:233` (enum do LLM) | `blocks, enables, shares_resource, feeds_data, competes_with, requires_coordination` |
| `ROLE_TO_DIRECTION` (`impact-engine.ts:838`) | `provides_to, depends_on, requires_coordination` |
| `DIRECTION_VERBS` (`impact-narrative.ts:54`) | 10 valores, **sem** `feeds_data` e `competes_with` |

Linhas com `feeds_data` / `competes_with` — que o prompt autoriza explicitamente —
caem no fallback `'relates to'` na narrativa "Why this matters".

- [x] Adicionar `feeds_data` ("feeds data to") e `competes_with`
      ("competes for resources with") a `DIRECTION_VERBS`.
- [x] Criar `IMPACT_DIRECTIONS` em `target-catalog.ts` (ao lado de `IMPACT_TYPES`)
      como fonte única de verdade, documentando os 3 produtores da coluna.
- [x] Alinhar o enum do prompt. **Achado extra:** o prompt contradizia a si mesmo
      — a seção de project-relations mandava emitir `depends_on`/`supersedes`,
      que não constavam do enum de `direction` logo abaixo. E o banco confirma:
      há 20 linhas `depends_on` e 3 `supersedes` gravadas. Enum corrigido para
      incluí-los.
- [x] Validar `direction` e `impact_type` em `parseImpactResponse`.

**Desvio do plano — tratamento diferente para cada campo.** O plano dizia
"preferir descartar e logar" para ambos. Medindo, os dois casos não são
simétricos:

| Campo | Está na UNIQUE key? | Custo de um valor inválido | Decisão |
|---|---|---|---|
| `impact_type` | **Sim** | Abre um slot de chave próprio → a mesma aresta entra duas vezes | Descarta + loga `source→target` |
| `direction` | Não | Só uma frase vaga ("relates to") na narrativa | Cai no default existente + conta |

Descartar uma aresta real por causa do rótulo de `direction` custaria mais do
que protege. Antes de validar, normaliza-se a variação de formatação
(maiúsculas, espaços, hífens), que é onde o LLM erra mais.

### A.3.1 Medição nas 197 linhas reais

```
impact_type fora do vocabulário  : { requires_coordination: 6 }
direction fora do vocabulário    : nenhuma
direction sem verbo na narrativa : nenhuma
```

O único valor inválido de `impact_type` é `requires_coordination` — um valor de
*direction* colocado no campo de tipo. Das 6 linhas, **5 já têm linha irmã com
tipo válido para o mesmo par** (as duplicatas previstas); **1 não tem** (id=110,
`PRJ0020146→PRJ0019060`), então o descarte perderia essa aresta.

Mantido o descarte, porque o fallback para um tipo default não resolveria nada:
ele abriria seu próprio slot na chave, preservando a duplicata *e* colocando um
rótulo errado. Mas o comentário no código foi corrigido (afirmava que essas
linhas seriam *sempre* duplicatas) e o descarte agora loga `source→target`, para
que uma aresta genuinamente perdida seja auditável em vez de silenciosa.

Observação lateral: 2 das 6 linhas descrevem **não-relações** ("there should be
no intersection between our projects", "is excluded from this project") — o LLM
está emitindo exclusões como impactos, apesar da seção EXCLUSIONS do prompt
mandar o contrário. Não tratado aqui; candidato a item novo.

### A.4 — #9 Remover código morto

- [x] Remover `rematerializeClaimsForLanguage` (`impact-engine.ts:941`) — exportada,
      zero call sites em `src/` e `scripts/`. Se a intenção era manter como
      ferramenta de reparo manual, expor via rota admin ou script; deixar
      exportada sem uso só acumula.

---

## Lote B — #1 Deduplicar o bloco de goals no prompt

### 1.1 Diagnóstico

- `project_goals` tem `UNIQUE(project_id, output_language)` (`db.ts:400`)
  → **1 linha de goals por projeto por idioma**.
- `projects` recebe `DELETE FROM projects` + insert da planilha inteira
  (`excel-parser.ts:118`) → **1 linha por revisão do comitê**.
- `IMPACT_ANALYSIS_QUERY` faz `LEFT JOIN projects p ON g.project_id = p.project_id`
  → 1 goal × K revisões = **K linhas**, todas com os mesmos campos de goals.

### 1.2 Efeito

`buildImpactPrompt:553-568` emite um bloco `Goal analysis N` por entrada. Os 9
campos emitidos ali (`Region`, `Digital Technologies`, `Change Management`,
`Security Impacts`, `Regional Impacts`, `IA Embedded`, `GIO/SL/DDS Impacts`,
`DDS/GIO Workload`, `Business Apps/CIs`) vêm **todos** de `g.*`. O que varia entre
revisões (gate, decision, review_date) nem aparece no bloco.

Resultado: texto idêntico repetido K vezes, em cada batch onde o projeto entra
(~N/21 batches). Queima tokens proporcionalmente a K e cria viés de repetição no
LLM ("K análises concordam"). Comprovado com teste isolado: 1 goal + 3 revisões
→ 3 blocos idênticos.

### 1.3 ⚠️ Armadilha — não deduplicar na origem

`goalEntries` alimenta **três consumidores com semânticas diferentes**:

| Consumidor | Precisa de | Se deduplicar na origem |
|---|---|---|
| `buildImpactPrompt:553` | 1 bloco por análise distinta | ✅ é o bug a corrigir |
| `fetchProjectSummariesForViews:306` (`history`) | as K revisões (pontos do TimelineView) | ❌ **timeline zera** |
| `reviewCount` (`:346`) | K | ❌ **contador de revisões zera** |

Deduplicar `goalEntries` dentro de `fetchAllProjectRecords` quebra o TimelineView
e o `reviewCount` **sem erro nenhum aparecer**. A dedup tem que ficar contida ao
ponto de emissão do prompt.

### 1.4 Tarefas

- [x] Em `buildImpactPrompt`, deduplicar por `goal_id` distinto antes do
      `forEach` da linha 553 (emitir 1 bloco por análise real).
- [x] Ajustar o header do bloco: o ordinal só aparece quando há >1 análise
      distinta (`Goal analysis [2026-06] (…)` no caso comum).
- [x] **Não** alterar `fetchAllProjectRecords`, `history` nem `reviewCount`.
- [x] Verificar que `const latest = r.goalEntries[0]` (`:484`) e
      `materializeClaimsAsImpacts:882` continuam funcionando — ambos já usavam só
      a primeira entrada, então não devem mudar de comportamento.
- [ ] Opcional (melhora legibilidade): separar em `ProjectFullRecord` os campos
      "análises de goals" dos campos "histórico de revisões", em vez de manter os
      dois papéis no mesmo array. Refactor maior — só se o fix contido ficar feio.

### 1.5 ⚠️ O bug é LATENTE nos dados atuais (medido 2026-08-31)

Medição no banco real (301 linhas em `projects`, 61 goals):

```
project_ids duplicados em projects: 0
linhas totais: 301 | project_ids distintos: 301
distribuição (linhas de projects por goal): { 1: 61 }
```

**Não há fan-out hoje** — cada goal casa com exatamente 1 linha de `projects`,
então o fix é um no-op sobre os dados atuais.

❌ **CORREÇÃO (2026-08-31).** Uma versão anterior desta seção afirmava que
`excel-parser` e `/api/drive/sheet` discordavam sobre a cardinalidade de
`projects`. **Isso estava errado.** Auditados os três caminhos de ingestão, todos
garantem 1 linha por `project_id`:

| Caminho | Como |
|---|---|
| `excel-parser.ts:85` | `dedupeByProjectId(rawRows)` antes do insert — mantém a `review_date` mais recente |
| `/api/drive/sheet` | update-if-exists |
| `drive-engine.ts:649` | só insere no ramo `else if (createMissing)`, isto é, quando não há match |

Ou seja, a cardinalidade **já é** "1 linha por projeto, guardando a revisão mais
recente" — exatamente a regra desejada. Não há nada a alinhar; o fan-out do #1 é
inalcançável pelos caminhos suportados (o fix continua valendo como guarda para
JSON/DB manipulado à mão, mas seu alcance é menor do que este plano dizia).

### 1.6 Consequência real: TimelineView é vestigial

Medido via `/api/projects` nos 61 projetos:

```
distribuição de reviewCount  : { 1: 61 }
distribuição de len(history) : { 1: 61 }
```

`history` e `reviewCount` existem para representar o histórico de revisões, mas
a ingestão colapsa esse histórico de propósito — o comentário do
`dedupeByProjectId` diz explicitamente que a planilha CDIO *tem* o projeto em
vários ciclos de review e que só o mais recente é mantido. Resultado: o
TimelineView sempre desenha **um único ponto por projeto**, e `reviewCount` é
sempre 1.

Não é bug de TimelineView — é o modelo de dados. Decisão em aberto:

- [ ] Ou aceitar e **remover** TimelineView / `reviewCount` (código morto que
      aparenta funcionar), ou **preservar** o histórico numa tabela separada
      (ex.: `project_reviews`) alimentada por `parseCdioSheet` antes do dedupe,
      deixando `projects` como está.

---

## Lote C — decisão pendente (não executar ainda)

### 6.1 — #2 Cobertura de pares mentirosa

`buildFullCoverageBatches:437` marca todos os pares `(i,j)` do batch como cobertos
**antes** do prompt existir. Depois `buildImpactPrompt:584-587` descarta projetos
que estouram `MAX_PROMPT_CHARS = 200_000`, com apenas `console.warn`.

Pares ficam contabilizados como analisados **sem nunca terem ido ao LLM**. É
determinístico → re-rodar não corrige. E o corte é a regra, não a exceção:
`DOCS_TOTAL = 8000` por projeto × `batchSize` 22 = até **176k dos 200k** só em
documentos.

**Duas abordagens:**

| Abordagem | Como | Trade-off |
|---|---|---|
| (a) Feedback do prompt builder | `buildImpactPrompt` retorna quem realmente entrou; batcher só marca coberto depois | Correto, mas acopla batcher↔prompt e pode gerar batches extras |
| (b) Orçamento por projeto ✅ | Cada projeto recebe `MAX_PROMPT_CHARS / batchSize`; nada é descartado | Simples e previsível, mas trunca conteúdo de projetos ricos |

- [x] **Decisão: (b)**. Restaura o invariante ("todo projeto do batch está no
      prompt") com muito menos superfície que (a). Truncar contexto é degradação
      graciosa; descartar projeto é mentira silenciosa. (a) segue disponível como
      upgrade futuro se a eficiência de tokens virar gargalo.
- [x] Implementar — `buildImpactPrompt` agora devolve `{ prompt, truncated }`,
      dá prioridade ao head estruturado e deixa os documentos absorverem a sobra
      do orçamento do projeto. O `dropped++/continue` foi removido.
- [x] Fazer o truncamento aparecer no status. **Desvio do plano original:** foi
      para um campo novo `warnings: string[]` em `ImpactAnalysisStatus`, não para
      `errors`. Motivo: `ImpactView.tsx:201` renderiza `errors.length` como
      contagem de erros e mostra só o último — jogar aviso ali inflaria a
      contagem e poderia esconder um erro real. `ImpactView` ganhou uma linha
      âmbar equivalente para os warnings.

### 6.1.1 ⚠️ Também latente hoje — mas prestes a ativar

`documents_cache` está com **0 linhas** (a sincronização do Drive ainda não
baixou documentos). Sem documentos, um batch de 22 projetos ocupa só as ~2-3k
chars de head por projeto, muito abaixo dos 200k — então o descarte nunca
disparou nos runs feitos até agora.

Isso muda no momento em que os documentos começarem a entrar: `DOCS_TOTAL`
(8000) × 22 projetos = **176k dos 200k**, e o descarte passaria a ser a regra.
O fix entrou antes de o problema aparecer, não depois.

### 6.2 — #6 Custo LLM O(N²)

⚠️ **Correção de uma estimativa anterior deste plano.** A conta original usava
`N(N−1)/462`, que é o ótimo teórico de empacotamento. O algoritmo guloso real é
bem menos eficiente. Números **medidos** rodando a lógica do batcher:

| N projetos | Pares | Batches (= chamadas LLM) | Cobertura |
|---|---|---|---|
| 61 (dados atuais) | 1.830 | **16** | completa |
| 100 | 4.950 | 36 | completa |
| 200 | 19.900 | **150** (estimativa antiga dizia ~86) | completa |
| 320 | 51.040 | 200 (cap) | **PARCIAL — 12.484 pares nunca comparados** |

Ou seja: o cap morde entre N=200 e N=320, não a partir de ~300 como eu havia
estimado. E o cap diário de LLM (500, `llm.ts:17`) é atingido antes disso.

### 6.2.1 Medição dos critérios de pré-filtro (2026-08-31)

Testado cada sinal contra os dados reais: 61 projetos, 1.830 pares possíveis,
**30 pares** com impacto projeto→projeto realmente encontrado. "Recall" = quantos
desses 30 sobreviveriam ao filtro.

| Critério | Pares mantidos | % do total | Recall | Perde |
|---|---|---|---|---|
| menção explícita | 2 | 0,1% | 2/30 (7%) | 28 |
| tech em comum | 327 | 17,9% | 26/30 (87%) | 4 |
| vendor em comum | 496 | 27,1% | 25/30 (83%) | 5 |
| GIO service em comum | 679 | 37,1% | 17/30 (57%) | 13 |
| DDS entity em comum | 509 | 27,8% | 14/30 (47%) | 16 |
| classificação de dados | 159 | 8,7% | 3/30 (10%) | 27 |
| **tech OU vendor OU menção** | **524** | **28,6%** | **28/30 (93%)** | **2** |
| ↑ OU GIO | 858 | 46,9% | 29/30 (97%) | 1 |
| ↑ OU DDS (tudo) | 1.110 | 60,7% | 29/30 (97%) | 1 |

Leituras:

- **DDS não serve como filtro**: adicioná-lo custa +252 pares e não recupera
  nenhum impacto a mais. Os valores são comuns demais (Airgas em 19 projetos,
  Americas em 17).
- **tech e vendor são os sinais fortes**; menção explícita é quase gratuita
  (2 pares) e vale incluir.
- 2 projetos não têm sinal nenhum — ficariam invisíveis a qualquer filtro e
  precisam de tratamento à parte.

Ressalva: o recall é medido contra o que o próprio LLM achou. Se existe um
impacto entre dois projetos que não compartilham nada, essa medição não o
enxerga. Amostra pequena (30 pares).

- [x] **Critério decidido:** `tech OU vendor OU menção OU GIO`, com projetos sem
      nenhum sinal sempre incluídos (não dá para filtrar por evidência que não
      se tem, e excluí-los em silêncio seria o mesmo bug de omissão que este
      plano inteiro combate). DDS deliberadamente fora: custa 1/5 do orçamento
      de pares e não recupera nenhum impacto.
- [x] Implementado como **degradação automática** (`buildFullCoverageBatches`):
      tenta cobertura total primeiro e a mantém sempre que couber; só cai para
      pares relacionados quando o cap truncaria o run. `packBatches` foi extraída
      para receber o conjunto-alvo de pares, e o `pad` (completar batch com
      projetos quaisquer) é desligado no modo filtrado — encher o batch ajuda
      quando se quer cobrir todos os pares, mas no modo esparso só consome
      orçamento de prompt sem cobrir par nenhum.

### 6.2.2 Medição da degradação

| N | Pares | Modo | Batches | Observação |
|---|---|---|---|---|
| 61 (hoje) | 1.830 | **full** | 16 | nada filtrado — comportamento inalterado |
| 126 (só 2026) | 7.875 | **full** | 59 | cabe folgado |
| 200 | 19.900 | **full** | 150 | ainda cabe |
| 301 (simulado) | 45.150 | **filtered** | 200 | ainda sobraram 3.009 pares |

⚠️ **A linha N=301 é simulação, não medição, e provavelmente é otimista para
baixo no filtro.** Só existem sinais reais para 61 projetos; para simular escalas
maiores os perfis foram replicados ciclicamente, o que faz perfis idênticos
casarem entre si e infla a taxa de "relacionados" para 75% (contra os **46,9%**
medidos nos dados reais).

Conclusão honesta: **o pré-filtro ajuda, mas pode não bastar sozinho em N=301.**
47% de 45.150 ainda são ~21 mil pares. O ganho garantido é outro: o sistema
agora **degrada dizendo o que deixou de fazer**, em vez de descartar em silêncio
um rabo arbitrário de pares.

- [ ] Quando os 240 goals restantes forem extraídos, **re-medir com sinais
      reais**. Se o pré-filtro não bastar, as alavancas seguintes são subir
      `MAX_BATCHES` (pesando o cap diário de LLM: 200 batches + 240 extrações de
      goals já são 440 de 500) ou estreitar o escopo.
- [x] Tornar o cap visível. `buildFullCoverageBatches` agora devolve
      `{ batches, uncoveredPairs }` e o run empurra um warning explícito
      ("Absence of an impact between two projects does not mean they were
      analysed"). Antes era um `console.warn` solitário. Com os 61 projetos
      atuais `uncoveredPairs` é 0, então nada aparece.

---

## Lote D — independentes

### D.1 — #7 Persistir estado do run

`analysisStatus` (`impact-engine.ts:39`) é module-level. Se o processo morre no
meio — **já aconteceu nesta máquina via OOM killer** — o run some sem rastro:
`isRunning` volta a `false`, nenhum registro de que parou pela metade, e as linhas
parciais ficam indistinguíveis das do run anterior. Também não sobrevive a
hot-reload do dev nem a múltiplos workers.

- [x] Persistir início/fim/abort do run numa tabela — criada `impact_runs`
      (`db.ts`), escrita por `startRunRecord` / `updateRunProgress` /
      `finishRunRecord`. Progresso é gravado **a cada batch**, então um kill no
      meio deixa registrado até onde chegou.
- [x] Na subida do processo, marcar runs órfãos como abortados —
      `reclaimOrphanedImpactRuns` em `db.ts`, chamada de `initSchema`.
- [x] Expor o resultado: `ImpactAnalysisStatus.lastRun` + aviso âmbar no
      `ImpactView` ("Last run was interrupted at batch 7/9 — results may be
      partial"). Sem isso a persistência seria write-only.

**Premissa documentada:** `reclaimOrphanedImpactRuns` assume **um único processo
escritor**, o que vale para este deploy (um Next atrás do nginx). Se um dia
rodar com múltiplos workers sobre o mesmo SQLite, um worker subindo abortaria o
run vivo de outro — aí precisa de um token de dono do processo.

Testado o ciclo completo contra a base real: linha `running` órfã inserida →
reload do módulo (equivale a boot) → virou `aborted` com `finished_at`
preenchido, `completed_batches` preservado em 7/9, e apareceu em `lastRun` na
API. Linha de teste removida depois.

### D.2 — #8 N+1 de documentos

`buildImpactPrompt:571` chama `getProjectDocuments(r.projectId)` por projeto por
batch, e cada projeto aparece em ~N/21 batches. `getProjectDocuments`
(`drive-engine.ts:875`) traz o `content_text` **inteiro** de todos os arquivos e só
depois corta em 4000/8000 chars.

- [x] Cortar no SQL. `getProjectDocuments` ganhou um parâmetro opcional
      `maxChars` que aplica `substr(content_text, 1, ?)`; `buildImpactPrompt`
      passa `DOC_SLICE`. Deep dive e a rota de evidence continuam lendo o texto
      inteiro (omitem o parâmetro).

Escolhido cortar no SQL em vez de cachear: resolve o custo real (ler blobs
inteiros para descartá-los) sem introduzir questões de invalidação de cache
dentro de um run longo. Um cache entre batches continua disponível se a
contagem de queries algum dia pesar. Verificado com teste de binding posicional
que `substr` recebe `maxChars` e o `WHERE` recebe `projectId` na ordem certa, e
que o filtro de `skipped_%` continua valendo.

---

## Verificação

Depois de cada lote:

- [ ] `npx tsc --noEmit` limpo
- [ ] `npm run lint`
- [ ] Subir com `./start.sh` e conferir que `/api/impact` responde 200
- [ ] Rodar uma análise real e comparar contagem de linhas em `projects_impact`
      antes/depois (esperado no Lote A: **menos** linhas — as duplicatas fantasma
      de pseudo-target somem)

## Log

<!-- Formato: `AAAA-MM-DD` — item — o que foi feito. Append no fim. -->

- `2026-08-31` — Auditoria inicial. 9 achados levantados, nenhum corrigido ainda.
  Fan-out do JOIN (#1) confirmado por teste isolado. Fora do escopo deste plano,
  corrigido no mesmo dia: `db.ts` `CREATE TABLE projects_impact` referenciava
  `dds_entities` na UNIQUE sem declarar a coluna, quebrando todo banco novo.
- `2026-08-31` — **#1 e #2 implementados.** `buildImpactPrompt` deduplica goals
  por `goal_id` e passou a garantir espaço para todo projeto do batch
  (`{ prompt, truncated }` + orçamento por projeto). `ImpactAnalysisStatus` ganhou
  `warnings: string[]`; `ImpactView` renderiza. `tsc --noEmit` limpo, rotas
  `/api/projects`, `/api/impact`, `/api/impact/preview` em 200.
  Regressão da seção 1.3 testada com seed sintético de K=3 revisões:
  `reviewCount=3`, `history=3`, gate/custo corretos — TimelineView intacto.
  Seed removido depois (banco de volta a 301 projects / 61 goals / 197 impacts).
  **Medição importante:** ambos os bugs são hoje latentes (ver 1.5 e 6.1.1) —
  os fixes são preventivos, não corrigem nada visível nos runs já feitos.
- `2026-08-31` — **#3 implementado.** `parseImpactResponse` passa a descartar
  linhas pseudo-target (`droppedPseudo` no log), tornando
  `materializeClaimsAsImpacts` o único escritor de arestas GIO/DDS. Comentário
  enganoso do `INSERT OR REPLACE` corrigido. `tsc` limpo; `npm run lint` sem
  novos problemas (os 3 erros que aparecem são pré-existentes, em `Header.tsx`,
  `DetailPanel.tsx` e `llm.ts`). Auditoria das 140 linhas pseudo-target reais:
  **zero fantasmas** — também latente (ver A.1.1), mas a defesa anterior dependia
  de o LLM obedecer um prompt que o usuário pode editar.
- `2026-08-31` — Padrão observado nos três: em todos, o **comentário do código
  afirmava uma garantia que o código não dava** (UNIQUE que sobrescreve,
  validação de catálogo, cobertura de pares). Vale desconfiar de comentário
  afirmativo nesse módulo ao mexer nos itens restantes.
- `2026-08-31` — **Lote A concluído (#4, #5, #9).** `isCanonicalTarget` passou a
  ser usada de verdade na materialização (140/140 claims reais passam — zero
  regressão). `IMPACT_DIRECTIONS` criado em `target-catalog.ts` como fonte única
  de verdade; `DIRECTION_VERBS` completo; enum de `direction` do prompt corrigido
  (contradizia a própria seção de project-relations do prompt, e o banco já tinha
  23 linhas com os valores que faltavam). `parseImpactResponse` valida
  `impact_type` (descarta + loga) e `direction` (coage ao default) — ver A.3.1
  para a medição e o desvio do plano. `rematerializeClaimsForLanguage` removida.
  `tsc` limpo, lint sem novos problemas, rotas em 200.
- `2026-08-31` — **Todos os 5 itens fechados até aqui eram latentes.** Nenhum
  corrigiu algo visível nos dados existentes; todos fecharam uma garantia que o
  código alegava ter.
- `2026-08-31` — **Lote D concluído (#7, #8) + parte do #6.** Tabela
  `impact_runs` + reclaim de órfãos + `lastRun` no status e aviso no
  `ImpactView` (ciclo testado ponta a ponta contra a base real).
  `getProjectDocuments` ganhou `maxChars` e corta no SQL. `uncoveredPairs`
  passou a sair do batcher como warning explícito.
  **Correção de estimativa:** a contagem de batches deste plano usava o ótimo
  teórico; medida a real, N=200 dá 150 batches (não ~86) e o cap morde entre
  N=200 e N=320. Ver tabela em 6.2.
- `2026-08-31` — **Erro deste plano corrigido:** a alegada divergência de
  cardinalidade entre `excel-parser` e `/api/drive/sheet` **não existe** — os três
  caminhos de ingestão já garantem 1 linha por projeto, com a revisão mais
  recente (ver 1.5). Nada a implementar. Efeito colateral descoberto: o histórico
  de revisões é descartado na ingestão, então TimelineView e `reviewCount` são
  vestigiais — sempre 1 ponto, sempre 1 (ver 1.6).
- `2026-08-31` — **Escala é o risco imediato, não hipotético:** há 301 projetos
  em `projects` e só 61 com goals extraídos. Quando os 240 restantes forem
  processados, os pares saltam de 1.830 para **45.150** e o cap de 200 batches
  passa a cortar. Medição dos critérios de pré-filtro em 6.2.1.
- `2026-08-31` — **#6 implementado: pré-filtro com degradação automática.**
  Decisão tomada por medição (6.2.1), não por palpite. Descartada a alternativa
  de escopar a análise por ano: medindo os pares realmente encontrados, **17 de
  33 cruzam anos** (PRJ0010712/2025 sozinho conecta a 4 projetos de 2026), então
  rodar só o ano vigente custaria ~metade das relações, enquanto o pré-filtro
  custa 1–2 de 30. Filtro de ano na UI descartado a pedido do usuário.
  Com 61 projetos o modo é `full` e nada muda. Ressalva em 6.2.2: o pré-filtro
  pode não bastar sozinho em N=301 — o ganho garantido é a degradação passar a
  ser declarada em vez de silenciosa.
- `2026-08-31` — **Todos os 9 achados fechados.** Pendências que sobram são
  decisões, não bugs: TimelineView vestigial (1.6), re-medir o pré-filtro quando
  os goals dos 301 estiverem extraídos (6.2.2), refactor opcional de
  `ProjectFullRecord` (1.4) e o LLM emitindo exclusões como impactos (A.3.1).
