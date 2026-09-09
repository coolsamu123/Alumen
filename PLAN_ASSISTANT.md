# Plano: Assistente de portfólio

Uma caixa de pergunta dentro da plataforma que responde sobre o portfólio —
projetos, iniciativas, impactos, tecnologias — usando os dados que a solução já
extraiu, **com o caminho de volta para a evidência em toda resposta**.

Medições feitas sobre o banco real em 2026-09-01. Companheiro de
[PLAN_INITIATIVES.md](PLAN_INITIATIVES.md).

## O caso de uso

Perguntas que hoje exigem abrir três abas e cruzar na cabeça:

> "Quais projetos tocam a DDS Airgas?"
> "O que a iniciativa DOC2DATA impacta?"
> "Quais projetos estão bloqueados por outro no cronograma?"
> "Onde está escrito que o projeto X depende do Y?"

## Não-objetivos

- Escrever no banco. O assistente **lê**. Disparar análises, editar projetos ou
  sincronizar Drive continuam sendo ações explícitas da UI.
- Substituir as views. Ele responde perguntas; o grafo, a matriz e o deep-dive
  continuam sendo a forma de explorar.
- Conversa de propósito geral. Fora do portfólio, ele recusa.

## Estado atual (medido 2026-09-01)

### O corpus

| Camada | Tamanho | Cabe no contexto? |
|---|---|---|
| Goals estruturados (62 linhas `success`) | 208.802 chars | sim |
| Arestas de impacto (327) — explicação + citações | 53.451 chars | sim |
| `projects.description` + `remarks` | 116.053 chars | sim |
| **Camada estruturada, somada** | **~378k chars ≈ 95k tokens** | **sim, inteira** |
| Documentos brutos (292 arquivos em `data/drive/`) | 16 MB ≈ 4M tokens | não |

### O vocabulário do domínio é minúsculo

| Dimensão | Valores distintos |
|---|---|
| `tech_tags` | 40 |
| `vendors` | 18 |
| `dds_entities_touched` | 17 |
| `gio_services_touched` | 5 |
| `impact_type` | 11 |

~90 termos no total. **Cabem inteiros num prompt.** Isso elimina o modo de falha
clássico de text-to-SQL: o modelo nunca precisa adivinhar o valor de um filtro,
porque recebe a lista fechada.

### Cobertura — o limite mais importante

| | |
|---|---|
| Projetos no portfólio | 302 |
| Com link de Drive | 94 |
| **Com goals analisados — o mundo do assistente** | **62 (21%)** |
| Com link mas ainda sem goals | 32 |
| Sem documento nenhum | 208 |
| Que aparecem em alguma aresta de impacto | 78 |

O assistente enxerga 21% do portfólio, e isso é decorrência direta de D9: ele só
responde do que já foi analisado. Os 32 com link e sem goals são recuperáveis
rodando o extractor. Os 208 sem documento não são — não há material.

Isso não invalida a feature, mas define o comportamento obrigatório: **toda
resposta declara sobre quantos projetos ela fala e sobre quantos não fala.** Um
"3 projetos tocam SAP" sem esse enquadramento é tecnicamente correto e
praticamente enganoso.

### Forma dos impactos

327 arestas: 123 projeto→projeto, 110 para o pseudo-alvo `DDS_IMPACTS`, 94 para
`GIO_SERVICES`. 191 `high`, 136 `low`. O assistente precisa entender que um
"impacto" tem três formas distintas de alvo, não uma.

### O que já existe para reusar

| Peça | Onde | Serve para |
|---|---|---|
| Abstração de provider, teto diário, journal de chamadas | `llm.ts` (304 linhas) | toda chamada do assistente |
| Modo JSON (`responseMimeType`) | `llm.ts:273` | planejamento estruturado sem function-calling nativo |
| Análise fundamentada por projeto | `deep-dive-engine.ts` (698 linhas) | é o protótipo do assistente, escopado a um projeto |
| Modelo de citação e evidência | coluna `citations`, `EvidencePanel`, `SourcePopover` | renderizar a resposta ancorada |
| Montagem de contexto com orçamento | `goals-extractor.ts` | não estourar a janela |
| FTS5 | SQLite 3.51.2 — **confirmado disponível** | busca em documento, camada 3 |

### Lacuna que bloqueia a camada de documentos

`documents_cache` tem **3 linhas** para 292 arquivos em disco. O `Sync All`
(`drive-sync-all.ts:processProject`) só baixa arquivos e nunca escreve nessa
tabela — quem escrevia era o `runDriveDownload` antigo
(`drive-engine.ts:runDriveDownload`, que o Sync All substituiu).

Consequência que **já existe hoje**, independente deste plano:
`api/impact/project/universe/route.ts:236` lê essa tabela para listar arquivos
de evidência, então essa listagem está degradada. Corrigir é pré-requisito do
Lote 4 e vale por si.

## Decisões de design

### D1 — Ferramentas exatas, não recuperação, como caminho primário

O reflexo é RAG. Seria errado aqui, por duas razões, e a segunda é a séria.

**A camada estruturada cabe inteira no contexto** (95k tokens). Buscar top-k num
corpus que cabe todo é trocar informação completa por um recorte.

**E a maioria das perguntas de portfólio é agregação, não busca.** "Quantos
projetos tocam Airgas?" respondida por recuperação **subconta
sistematicamente**: se 19 projetos tocam Airgas e o retriever traz 8, o modelo
responde "8" com toda a confiança. Isso é pior do que não responder, porque
parece certo — e o número não é hipotético: `impact-engine.ts:415` registra
Airgas em 19 dos 61 projetos e Americas em 17.

Então: perguntas de contar, listar e filtrar viram **SQL sobre colunas
indexadas**, e o conjunto de linhas devolvido *é* a citação.

### D2 — Planejar-executar-responder em JSON, sem function-calling nativo

`generateContent` (`llm.ts:222`) é um wrapper de um tiro: prompt → texto. Sem
histórico, sem function calling. Em vez de reescrevê-lo:

1. **Planejar** — o LLM recebe a pergunta, o catálogo de ferramentas e o
   vocabulário fechado; devolve JSON `{ tools: [{ name, args }] }`.
   Usa `json: true`, que já existe.
2. **Executar** — TypeScript roda as ferramentas. Determinístico, sem LLM,
   sem custo.
3. **Responder** — o LLM recebe pergunta + resultados e escreve a resposta,
   citando os ids que usou.

Duas chamadas por pergunta, zero dependência de o modelo configurado
(`gemini-3.1-pro-preview`) suportar function calling, zero mudança em `llm.ts`.

Se depois quisermos multi-turno de ferramentas, o passo 2 vira um laço.

### D3 — O planejador nunca inventa valor de filtro

O prompt do passo 1 carrega as ~90 constantes do vocabulário (D-medição acima).
Toda ferramenta que aceita filtro categórico valida o argumento contra a lista
e **rejeita o que não estiver nela**, devolvendo os valores válidos ao passo 3
em vez de rodar uma query que casaria com nada.

Um filtro inventado que devolve zero linhas é indistinguível, para o modelo, de
"não existe nenhum" — e é assim que se produz um "não há projetos tocando SAP"
categórico e errado.

### D4 — Nenhuma resposta sem procedência

Toda ferramenta devolve, junto com os dados, os identificadores da origem
(`project_id`, `goal_id`, `impact.id`, caminho do arquivo). O passo 3 é
obrigado a citá-los, e a UI os renderiza com o `SourcePopover` que já existe.

Não é enfeite: os goals **já são** extração de LLM. O assistente é uma segunda
camada de inferência sobre a primeira, e os erros compõem. A mitigação tem que
ser estrutural — nunca deixar o assistente ser a única coisa entre a pergunta e
o documento.

### D5 — A resposta é datada

Cada linha de goals tem `analyzed_at` e `source_signature`. Uma extração de três
meses atrás responde com a mesma confiança de uma de ontem. O passo 3 recebe as
datas e a resposta carrega o intervalo: "com base em análises de 12/06 a 31/08".

### D6 — FTS5 antes de embeddings

Quando a camada de documentos entrar (Lote 4), o índice é FTS5 — confirmado
disponível no build atual.

Para um corpus dominado por nomes próprios — códigos `PRJ`, nomes de sistemas,
fornecedores, entidades DDS — BM25 casa melhor do que similaridade vetorial,
custa zero infraestrutura, e o motivo de cada resultado é inspecionável.
Embeddings só se justificam se aparecerem perguntas parafraseadas o bastante
para o léxico falhar; aí entram **ao lado**, não no lugar.

### D7 — Faixa de orçamento própria

`STROM_LLM_DAILY_CAP` = 500/dia, compartilhado. Um assistente é intermitente e
interativo: uma sessão de perguntas não pode comer a cota do pipeline noturno.
As chamadas usam `context: 'assistant'` (o journal `llm_calls` já é por
contexto) e um teto próprio, `STROM_ASSISTANT_DAILY_CAP`, verificado antes do
teto global.

### D9 — Somente leitura, sobre análise já existente

Resposta à questão 3. O assistente **nunca dispara análise**: não roda o Goals
Extractor, não roda o Impact, não sincroniza Drive. Toda resposta sai de
`project_goals`, `projects_impact`, `projects` e (Lote 4) dos arquivos já
baixados.

É possível e é o desenho — já estava nos não-objetivos. Duas consequências que
seguem daí e não são negociáveis:

- O assistente é permanentemente limitado pela cobertura do pipeline (ver
  *Cobertura*). Ele não pode responder sobre um projeto não analisado, e tem que
  dizer isso em vez de silenciar.
- Uma pergunta sobre um projeto sem goals recebe "esse projeto ainda não foi
  analisado", não uma resposta montada a partir do nome e da descrição da
  planilha. Improvisar a partir de metadados é exatamente como se produz uma
  resposta plausível e falsa.

### D10 — Responde no idioma da pergunta

Resposta à questão 2. Independente de `outputLanguage` em `config.json`, que
segue governando os campos livres do pipeline (goals, impacto) — lá a
consistência entre linhas importa mais do que a preferência do leitor. Numa
conversa é o contrário.

O passo 3 recebe a instrução de responder no idioma da pergunta. Nomes
canônicos, ids e enums nunca são traduzidos, mesma regra do
`FR_OUTPUT_DIRECTIVE` que já existe em `llm.ts`.

### D8 — Atrás do mesmo portão das outras rotas caras

`/api/assistant` entra em `PROTECTED_PREFIXES` no `src/middleware.ts`. Sem isso,
qualquer pessoa no hostname público gasta a cota — e lê o portfólio inteiro.
Mesma regra que `/api/analyze` já segue.

## Arquitetura

### Schema

```sql
-- Transcrição. Existe para o multi-turno ("e o segundo?") e para poder auditar
-- o que o assistente respondeu, com quais ferramentas e a que custo.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL,
  role        TEXT NOT NULL,              -- 'user' | 'assistant'
  content     TEXT NOT NULL DEFAULT '',
  tool_calls  TEXT NOT NULL DEFAULT '[]', -- plano do passo 1, como executado
  citations   TEXT NOT NULL DEFAULT '[]', -- ids que fundamentam a resposta
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_msg_thread ON assistant_messages(thread_id);
```

### Catálogo de ferramentas (Lote 2)

Módulo novo `src/lib/assistant-tools.ts`. Cada uma é uma função TypeScript pura
sobre SQL, com schema declarado que alimenta o prompt do passo 1.

| Ferramenta | Responde | Índice usado |
|---|---|---|
| `listProjects({ dds, gate, source, hasGoals })` | "quais projetos…" | `idx_projects_dds`, `idx_projects_gate` |
| `findByVocabulary({ dimension, value })` | "quem toca Airgas / SAP / fornecedor X" | `idx_goals_tech_tags` |
| `getImpacts({ projectId, direction, type, severity })` | "o que X impacta / o que impacta X" | `idx_impact_source`, `idx_impact_target` |
| `getProject({ projectId })` | ficha completa: metadados + goals + arestas | `idx_goals_project_lang` |
| `portfolioStats({ groupBy })` | "quantos por DDS / gate / tecnologia" | — |
| `getTimelineDependencies({ projectId })` | "quem bloqueia quem" | `timeline_struct` |
| `searchDocuments({ query, projectId })` | "onde está escrito" — **Lote 4** | FTS5 |

Todas devolvem `{ rows, citations, asOf }`. Nenhuma devolve prosa livre.

### Fluxo

```
pergunta
   │
   ├─ passo 1: LLM (json)  → { tools: [...] }        context='assistant-plan'
   │            prompt = pergunta + catálogo + vocabulário fechado + histórico compactado
   │
   ├─ passo 2: TypeScript  → resultados exatos       sem LLM
   │            valida args contra o vocabulário; argumento inválido vira erro explicado
   │
   └─ passo 3: LLM (texto) → resposta + citações     context='assistant-answer'
                prompt = pergunta + resultados + datas (D5) + regra de citação (D4)
```

Perguntas de síntese ("quais os temas de segurança recorrentes?") não têm
ferramenta que as responda por filtro. Para elas o passo 1 pode pedir
`wholePortfolioContext()`, que monta a camada estruturada inteira com o
orçamento do `goals-extractor` — cabe, conforme medido.

### API e UI

- `POST /api/assistant` — `{ threadId?, question }` → `{ threadId, answer, citations, toolCalls, asOf }`.
- Streaming fica para depois: as duas chamadas levam poucos segundos e o
  progresso interessante ("consultando impactos de INI0000001") vem do passo 2,
  que é instantâneo.
- UI: painel lateral acionável de qualquer view, reusando `AIAnalysisPanel.tsx`
  como base e `SourcePopover` para as citações. Clicar numa citação navega para
  o projeto ou abre a evidência — o assistente vira porta de entrada para as
  views, não uma ilha.

## Lotes

| Lote | Conteúdo | Entregável verificável |
|---|---|---|
| 1 | Schema + `POST /api/assistant` esqueleto + portão no middleware | Pergunta ida e volta, sem ferramenta, gravada na transcrição |
| 2 | `assistant-tools.ts`: as 6 ferramentas estruturadas + validação de vocabulário | Cada ferramenta testada isoladamente contra o banco real |
| 3 | Laço planejar-executar-responder + citações + datas | "Quais projetos tocam Airgas?" devolve os 19, citados |
| 4 | Índice FTS5 dos 292 arquivos + `searchDocuments` (**depende de corrigir `documents_cache`**) | "Onde está escrito que X depende de Y?" cita arquivo e trecho |
| 5 | UI: painel, citações clicáveis, histórico de thread | Usável de dentro de qualquer view |
| 6 | Teto próprio (`STROM_ASSISTANT_DAILY_CAP`) + contexto no painel de stats | Sessão de chat não consome a cota do pipeline |

Lotes 1–3 já entregam valor sozinhos: cobrem as perguntas de "quais/quantos",
que são a maioria, sem depender do índice de documentos.

## Riscos e limites

| Risco | Avaliação |
|---|---|
| Inferência sobre inferência | Goals já são extração de LLM. Mitigado por D4 (citação obrigatória), não eliminado |
| Resposta confiante sobre dado velho | Mitigado por D5. Não resolve o caso de o documento ter mudado sem mudar de tamanho — limitação conhecida do `source_signature` (`goals-scanner.ts`) |
| Pergunta fora do escopo do catálogo | O passo 1 devolve plano vazio e o passo 3 diz o que **não** consegue responder, em vez de improvisar |
| Custo por pergunta | 2 chamadas. Com 500/dia e 19 usadas hoje, folga larga — mas D7 separa as faixas antes que isso mude |
| Superfície pública | D8. Sem isso, o portfólio inteiro fica consultável por quem tiver o hostname |
| Ferramenta lenta em `wholePortfolioContext` | 95k tokens por chamada é caro em latência e em tokens. Só quando o passo 1 pedir explicitamente |

## Questões em aberto

1. ~~**Idioma.**~~ Decidido — ver D10: responde no idioma da pergunta.
2. ~~**Dispara análises?**~~ Decidido — ver D9: nunca. Somente leitura sobre o
   que o pipeline já produziu.

3. **Ainda em aberto: que perguntas você mais quer fazer?** A resposta dada
   ("concordo") concorda com o critério, mas não diz de que lado ele cai — e é
   a questão que decide se o Lote 4 existe.

   Concretamente: o filtro que já existe na toolbar
   (`ProjectContext.tsx:125-137`) cobre DDS, gate, decisão, ano e busca textual.
   Perguntas do tipo "quais projetos gate 2 na DDS Airgas" **já têm resposta
   sem assistente nenhum**. O que o filtro não faz é atravessar o grafo de
   impacto combinando atributos:

   > "quais iniciativas tocam algo que a DOC2DATA também toca"
   > "quem depende de um projeto que ainda está no gate 1"
   > "quais projetos de segurança compartilham fornecedor"

   Se as suas perguntas reais forem desse segundo tipo, a feature se paga. Se
   forem do primeiro, ela é uma camada de LLM por cima de um filtro que já
   funciona — e o custo é responder aproximadamente o que hoje se responde
   exatamente.
   resposta:
