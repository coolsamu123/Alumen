# Revisão: prompts de LLM e Target Catalog

Revisão dos textos que o Alumen envia ao Gemini e das definições canônicas de GIO Service Lines e entidades DDS.

**Escopo**

- Os dois prompts editáveis: Goals e Impact (`src/lib/prompts.ts`).
- Os dois prompts montados em código: Deep Dive (`deep-dive-engine.ts:219`) e Planning (`project-planning-engine.ts:282`).
- O Target Catalog: `target-catalog.data.json` + `target-catalog.ts`.
- Os vocabulários de DDS, tecnologia, vendor e classificação de dados (`dds-catalog.ts`, `tech-catalog.ts`).
- Como cada peça é montada, validada e exibida.

**Método:** leitura do código e medições somente leitura no `cioo.db` de produção, em 2026-09-14. A base medida tem 69 extrações de Goals com sucesso (prompt v4, em inglês), 181 claims, 21 relações entre projetos, 506 impactos e 313 documentos em cache. O modelo em uso é `gemini-3.1-pro-preview` (`config.json`).

Nada foi alterado no código.

---

## 0. Veredito

**A arquitetura está certa e deve ficar.** Três escolhas se sustentam com os números:

- claims atômicos ancorados em citação;
- materialização determinística das arestas GIO/DDS;
- validação contra vocabulário canônico.

**Mas não está bom o bastante para deixar como está.** Três problemas afetam o que as pessoas leem hoje na tela, e outros minam a consistência:

| # | Problema | Evidência | O que o usuário vê | Custo de corrigir |
|---|---|---|---|---|
| 1 | **Frase de impacto invertida** (§2.1) | 134 linhas `provides_to` + as de `downstream_consumer` | "Projeto X *provides services to* User Workplace" quando é o contrário | Baixo, sem chamar o LLM |
| 2 | **Severidade sem critério** (§2.2) | 82% dos claims são `high` (148/181) | "High" não distingue mais nada | Médio (nova extração) |
| 3 | **O catálogo não chega a quem decide** (§2.3) | As descrições só entram no Deep Dive; `typicalRoles`/`typicalImpactTypes` não são usados em nenhum prompt | Confusão HHC × HC D&IT, Airgas × Americas; 31% das entidades "touched" sem nenhum claim | Médio (reescrever o catálogo + nova extração) |
| 4 | Conteúdo do catálogo (§2.4) | 28 nomes de pessoas, fatos datados, sobreposições entre SLs, siglas por extenso erradas | Deep Dive citando organogramas; limites ambíguos | Médio (fronteiras já decididas, §3) |
| 5 | Prompt de Impact se contradiz (§2.5) | Proíbe linhas GIO/DDS e dá exatamente essas linhas como exemplo | Tokens gastos em linhas descartadas | Baixo |
| 6 | Citações que não resolvem (§2.6) | 140/279 linhas GIO/DDS sem citação; 22 de 52 `doc_url` inexistentes | "Sources" vazio ou apontando para nada | Médio |
| 7 | Campos do Goals redundantes ou ambíguos (§2.7) | `ia_embedded` mistura "não tem IA" com "não documentado" (48% "Not identified") | Dado que não dá para filtrar | Baixo (junto com a nova extração) |
| 8 | Parâmetros de geração (§2.8) | Goals sem modo JSON e sem temperatura | Rodar de novo gera outros claims | Baixo |
| 9 | Listas canônicas copiadas em 6 lugares (§2.9) | Já divergiram (10 × 11 `impact_type`) | Editar o catálogo não muda o prompt | Médio |

### Execução: feito e falta

| Fase | Estado |
|---|---|
| Revisão, decisões e atlas | ✅ feito (14/09/2026) |
| A: corrigir sem chamar o LLM | ✅ em produção (14/09/2026); falta só uma verificação |
| B: conjunto de referência | 🟡 **ferramenta pronta; falta a revisão do gabarito** *(negócio)*, ver §0.2 |
| C: reescrever o catálogo | ✅ **feita** (14/09/2026), ver §0.1 |
| D: prompt de Goals v5 | ⬜ não iniciada |
| E: prompt de Impact v2 | ⬜ não iniciada |

#### ✅ Feito

**Revisão, decisões e atlas**
- [x] Revisão medida em produção (§2) e linha de base (§5)
- [x] Decisões do negócio sobre fronteiras, hierarquias e nomes antigos (§3.1, itens 1 a 12)
- [x] Atlas de entidades: `ATLAS_ENTIDADES.md` e versão interativa

**Fase A** (detalhe e números no §4)
- [x] Direção dos papéis corrigida (`ROLE_TO_DIRECTION`, comentários, ajuda da tela `/admin/catalog`)
- [x] Linhas GIO/DDS regravadas a cada rodada de Impact, sem deixar órfãs
- [x] Dados migrados com backup: 279 → 181 linhas GIO/DDS, 0 órfãs, 0 frases invertidas
- [x] Prompt de Impact sem contradições: alvo só projeto, exemplos projeto → projeto, `parallel → organizational`, definição de cada `impact_type`, `[]` válido, lista GIO atualizada
- [x] Perspectiva dos papéis explícita no prompt de Goals
- [x] Descarte, no código, das citações com link fora dos documentos do lote
- [x] Rótulos "Gemini 2.0 Flash" removidos

#### ⬜ Falta

**Fase A: verificação pendente**
- [ ] Na próxima rodada de Impact, confirmar a linha `dropped N citation(s)` no log e zero citações novas com link inexistente

**Fase B: conjunto de referência** — ferramenta pronta, ver §0.2
- [x] Escolher 10 projetos variados, incluindo PGM0001209 e PRJ0019818 — proposta por dado em `scripts/reference-set.cjs propose`
- [ ] **Revisar** alvos, papéis e severidades de cada um *(negócio)* — `data/reference-set.json` já vem pré-preenchido
- [x] Script que compara a extração com o gabarito

**Fase C: reescrever o catálogo** — ✅ feita, detalhe no §0.1
- [x] Campos novos no catálogo e na tela `/admin/catalog`: `scope`, `signals`, `notThis`, `parent`, `aliases`, `notes`
- [x] Texto de cada entidade sem nomes de pessoas nem campanhas datadas, com as fronteiras do §3.1
- [x] `parent`: Airgas → Americas; GDO, Industrial Apps, Data & AI Apps e Digital Factory → GDS; as cinco service lines → GIO
- [x] Aliases do §3.1, item 12, aplicados na normalização (`dds-catalog.ts`)
- [x] Migrar E&C e IDD para InnoTech: 3 donos, 5 linhas "touched", 1 claim e 1 linha de impacto
- [x] Corrigir as siglas por extenso: `prompts.ts`, `deep-dive-engine.ts`, `catalog/page.tsx`
- [x] Normalizar `projects.dds` na importação **e nos dados já gravados**
- [ ] Confirmar o pai de Enterprise Apps e de CDIO Office *(negócio)* — registrado em `notes`

**Fase D: prompt de Goals v5**
- [x] Comportamento do `data/prompts.json` resolvido — override versionado, ver §0.3
- [ ] Cartões do catálogo injetados no prompt (§2.3)
- [ ] Rubrica de severidade (§2.2)
- [ ] Listas "touched" derivadas dos claims (§2.7)
- [ ] Campos `ia_embedded_status` e `unmapped_terms` (§2.7)
- [ ] Regra da citação: a frase que sustenta o claim, em vez da primeira do parágrafo (§2.6)
- [ ] Modo JSON e temperatura baixa (§2.8)
- [ ] Listas canônicas geradas do código por placeholders, com uma fonte só (§2.9)
- [ ] Validar no conjunto de referência; só então subir `GOALS_PROMPT_VERSION`, reprocessar os 69 projetos (~50 min) e rodar o Impact de novo

**Fase E: prompt de Impact v2**
- [ ] Placeholder do catálogo no lugar da lista GIO escrita à mão
- [ ] Relações entre projetos materializadas no código, como os claims
- [ ] Temperatura baixa
- [ ] Uma fonte só de documentos para Goals, Impact e Deep Dive, para as citações resolverem (§2.6)

---

## 0.1. Resultados da Fase C (2026-09-14)

### O formato

`TargetDefinition` ganhou `scope`, `signals`, `notThis`, `parent`, `aliases` e
`notes`, persistidos em `target-catalog.data.json` e editáveis em
`/admin/catalog`. `description` continua dizendo o que a entidade **é**; os
campos novos dizem onde ela **para**, que era o que faltava.

Os 5 cartões GIO e os 18 DDS estão preenchidos.

### 🐞 As descrições levavam nomes de pessoas e datas para o Gemini

A varredura por "sem nomes de pessoas nem campanhas datadas" achou mais do que
texto velho: **quatro diretores nomeados** e iniciativas presas a datas —
"piloto em meados de 2026", "descomissionamento em outubro de 2026", "roadmap
2027–2030". Tudo isso ia no prompt, em toda chamada.

Além do dado pessoal, o conteúdo envelhece sozinho: em um ano o cartão estaria
errado sem ninguém ter mexido nele.

As cinco descrições GIO caíram de 986–2714 para 113–162 caracteres, com o
conteúdo durável migrado para `scope` e `signals`. A de InnoTech dizia que a
fusão estava *"planejada"* e que E&C e IDD *"permanecem distintas no roadmap
2026"* — o oposto do que o §3.1 item 4 decidiu.

### 🐞 Um alias GIO escondido no vocabulário DDS

Ao escrever os aliases eu pus `GIO Network & Telecom → Site Infrastructure` no
mapa DDS. `Site Infrastructure` é nome **GIO**, e `normalizeDds()` devolvia o
alias sem verificar se ele pertencia ao catálogo perguntado — uma service line
GIO sairia como entidade DDS.

Corrigido de duas formas: os aliases GIO foram para um `GIO_ALIASES` próprio com
`normalizeGio()`, e o `normalizeDds()` passou a exigir que o alias caia dentro do
catálogo DDS.

### Nomes canônicos

`E&C` e `IDD` saíram de `CANONICAL_DDS_NAMES` e viraram aliases de InnoTech.
`DDS_CATALOG` deixou de ser uma segunda cópia da lista e passa a derivar de
`CANONICAL_DDS_NAMES` — as duas divergiam, que é como `E&C` podia ser canônico
numa e não na outra (§2.9).

Os trigramas `DHC`/`DIN`/`BEC` ficam num mapa separado, **fora** da normalização
de texto livre: `DIN` também é a norma técnica alemã.

### Migração E&C/IDD → InnoTech

O plano estimava "6 marcações touched"; o banco tinha 5, e o que importava era
outro detalhe: **4 delas já continham InnoTech ao lado de E&C**, então a troca
gera duplicata dentro do array e exige deduplicação —
`["InnoTech","E&C","IDD"]` colapsa em `["InnoTech"]`.

A chave UNIQUE dos impactos não chegou a ser um problema: não havia aresta
equivalente já em InnoTech.

Dos 3 "claims" que a busca textual apontou, **2 eram falso positivo** — o `E&C`
aparecia em nome de arquivo (`..._E&C_SLIM_for_Europe_...`), não em campo de
alvo. Real: 1.

Aplicado em transação, com backup: 3 donos, 5 linhas touched, 1 claim, 1
impacto. Verificação final em 0.

### Grafias do dono

`normalizeOwner()` no `excel-parser.ts` canonicaliza na importação, e os dados
já gravados foram migrados: 16 grafias distintas viraram 15 entidades. `GIO`
fica como está — é dono válido de 28 projetos, só não é alvo de impacto.

Valor desconhecido é **preservado**, não descartado: a planilha pode nomear uma
entidade que o catálogo ainda não aprendeu, e apagar em silêncio perderia o dado
que a importação existe para trazer.

---

## 0.2. Fase B: a ferramenta (2026-09-14)

`scripts/reference-set.cjs`, com três comandos.

**`propose`** escolhe os 10 por dado, não por intuição, e diz o porquê de cada
um: os dois nomeados no plano, 2 de alto volume GIO, 2 de alto volume DDS, 2 com
documentação pobre (1 documento — onde o modelo tem menos base e mais tendência
a inventar) e um por região ainda não representada.

Seleção atual: `PGM0001209`, `PRJ0019818`, `PRJ0010712`, `PRJ0017466`,
`PRJ0020030`, `PRJ0020276`, `PRJ001395`, `PRJ0019049`, `PRJ0020429`,
`PRJ0019856` — cobrindo Americas, Europe e APAC. **AMEI não tem projeto com
goals**, então não entra; vale saber que essa fronteira fica sem teste.

**`template`** gera `data/reference-set.json` **pré-preenchido com o que a v4
extrai hoje**: 10 projetos, 38 entradas. A tarefa de negócio passa a ser
*revisar e corrigir*, que é onde o julgamento agrega — transcrever 10 gabaritos
em branco não é.

**`compare`** confronta extração e gabarito e imprime precisão de alvo,
cobertura, papel e severidade.

**O `compare` recusa rodar sobre projeto não revisado.** Cada entrada nasce com
`reviewed: false`, e comparar a v4 contra o que a própria v4 produziu daria 100%
de precisão sem significado nenhum — o número mais perigoso possível, porque
parece aprovação.

O arquivo fica **fora do Git de propósito**: lista nomes de projetos da Air
Liquide e o mapeamento esperado de cada um, e o repositório é público. Registrado
no `.gitignore` com essa razão, para não parecer esquecimento.

---

## 0.3. O `data/prompts.json` (2026-09-14)

A Fase D exigia decidir isto antes de começar, e a investigação mostrou um risco
maior do que "o arquivo ganha do código".

`GOALS_PROMPT_VERSION` decide se um projeto é **reanalisado**; `getPrompts()`
decide **com que texto**. Os dois eram desconectados, e o arquivo, uma vez
salvo pela tela, vencia para sempre — sem versão e sem aviso.

Subir a versão com um override antigo no lugar daria o pior dos dois mundos:

- os 69 projetos reprocessados (~50 min de Gemini);
- o prompt **antigo** usado mesmo assim;
- cada linha carimbada `prompt_version = 5`, com o banco afirmando uma
  procedência que não aconteceu.

**Decisão:** o override é versionado. `savePrompts()` grava
`basedOnGoalsVersion`; `getPromptsState()` só honra o arquivo enquanto o código
não passou dele. Quando passa, o código vence e o estado devolve
`supersededFrom`, para a tela dizer que a edição foi superada — descartar em
silêncio seria trocar um bug por outro.

Arquivo sem marcador conta como baseado na versão anterior, então qualquer
aumento futuro o supera. `DELETE /api/prompts` volta ao prompt do código.

Efeito colateral resolvido no caminho: `prompts.ts` passou a importar a
constante de `goals-analyzer.ts`, fechando um ciclo entre os dois módulos. A
constante mudou para `prompt-version.ts`, sozinha. Um ciclo aqui não quebraria o
build — devolveria `undefined` na inicialização conforme a ordem de carga, e
todo override apareceria como superado, ou nenhum.

---

## 1. O que manter

- **As citações do Goals são reais.** 168 de 181 citações de claims foram encontradas literalmente no texto dos documentos em cache. As 21 de 21 `project_relations` também, e 179 de 182 `out_of_scope`.
- **O modelo segue os vocabulários.** Comparando a resposta bruta (`raw_gemini_response`) com o que foi gravado, os validadores descartaram 1 tag e 0 claims. Nenhuma resposta deixou de ser parseada.
- **`summary_one_line` cumpre o formato.** A mediana é de 167 caracteres, e só 1 resumo em 69 saiu da faixa de 100 a 180.
- **Materialização determinística dos claims** (`impact-engine.ts:1105`) e **descarte de pseudo-alvos vindos do LLM** (`impact-engine.ts:920`): é o desenho certo.
- **As 21 relações entre projetos viraram impacto.**
- **Diretiva de idioma FR** (`llm.ts:33`): protege chaves, enums e nomes canônicos.
- **Prompts de Deep Dive e Planning:** as regras de grounding, as fontes obrigatórias por seção, o tratamento de exclusões e "a planilha manda em data e decisão" estão bem resolvidos. Só precisam receber o catálogo reescrito (§2.10).

---

## 2. Problemas encontrados

### 2.1 A frase de impacto está invertida para dois papéis

O prompt de Goals define os papéis do ponto de vista do **alvo** (`prompts.ts:108-109`):

- `primary_provider`: *o alvo fornece* a capacidade que o projeto consome;
- `downstream_consumer`: *o alvo consome* o que o projeto produz.

A materialização lê os papéis do ponto de vista do **projeto** (`impact-engine.ts:1097-1103`):

| Papel | Direção gravada | Frase na tela (`impact-narrative.ts:82,119`: `${source} ${verb} ${target}`) | Sentido correto |
|---|---|---|---|
| `primary_provider` | `provides_to` | "Projeto **provides services to** Security & Compliance" | o projeto **depende de** Security & Compliance |
| `downstream_consumer` | `depends_on` | "Projeto **depends on** Europe" | o projeto **fornece para** Europe |

**Caso concreto (PRJ0022184, o do screenshot do Universe):** o claim diz `User Workplace role=primary_provider`, com a citação "Secure Privileged Access Workstations (PAW)…". A tela mostra *"Reinforcement of High Privilege Accesses and Environments provides services to User Workplace"*.

**Tamanho:** 134 linhas `provides_to` (74 GIO, 60 DDS), vindas de 89 claims `primary_provider`, mais as linhas de 13 claims `downstream_consumer`.

**Agravante:** a ajuda da tela `/admin/catalog` (`catalog/page.tsx:45`) define `primary_provider` como *"Project provides this target as its main output"*, o terceiro sentido diferente. Quem edita os `typicalRoles` é orientado ao contrário.

**Proposta, sem chamar o LLM:**

1. Trocar o mapeamento: `primary_provider → depends_on` e `downstream_consumer → provides_to`. `blocked_by → depends_on` já está certo.
2. Recalcular `direction` das linhas GIO/DDS existentes a partir dos claims. `direction` não faz parte da chave UNIQUE (`impact-engine.ts:945`), então o `UPDATE` é seguro.
3. Corrigir o `ROLE_HELP` e deixar a perspectiva explícita no prompt: "role describes what the TARGET does for this project".
4. **Linhas órfãs:** PRJ0022184 tem 3 claims hoje e 7 linhas GIO no banco. As 4 extras não correspondem a nenhum claim atual. A rematerialização deve apagar as linhas GIO/DDS do projeto antes de regravar.

### 2.2 Severidade sem critério

O prompt dá o enum `high | low` para claims e **nenhuma regra** para escolher entre os dois.

| Papel | high | low |
|---|---|---|
| `primary_provider` | 73 | 16 |
| `regional_executor` | 35 | 7 |
| `risk_owner` | 27 | 5 |
| `downstream_consumer` | 8 | 5 |
| `blocked_by` | 5 | 0 |
| **Total** | **148 (82%)** | **33** |

Um projeto que "roda em AWS" e um que "precisa que Security & Compliance aprove uma exceção antes do Gate 2" recebem o mesmo `high`. Nas linhas de impacto, 265 de 506 são `high`.

**Proposta de rubrica** para os dois prompts:

```
severity = "high" only when at least one is true, per the quoted evidence:
  - the target must deliver, change, approve or fund something specific for this project;
  - the target's decision or capacity can block a gate, go-live or decommission date;
  - a security/compliance exception, major reservation or unresolved risk is stated;
  - committed effort from the target is quantified (FTE, man-days, budget).
Otherwise "low": the project uses an existing standard service as-is, mentions the
target for context, or needs only routine coordination.
```

### 2.3 O catálogo não chega a quem decide

Quem escolhe **qual** alvo, **qual** papel e **qual** tipo é o prompt de Goals. Ele vê só a lista de nomes (`prompts.ts:26-32`).

- **Descrições:** entram só no Deep Dive (`deep-dive-engine.ts:264`), depois que o claim já existe.
- **`typicalRoles` / `typicalImpactTypes`:** não são usados em nenhum prompt, só na tela de admin.
- **Comentários enganosos:** o `target-catalog.ts` diz que `getTargetEntry` é "used by the Goals prompt builder", e o `StromArchitecture/stages.ts:154` repete isso. **A função não é chamada em lugar nenhum.**

**Sinais de confusão nos dados:**

| Sinal | Medida |
|---|---|
| **HHC × HC D&IT:** a citação diz "**DDS HHC**: support / Expertise on the interface between HHC solutions and Payroll", mas o alvo gravado é **HC D&IT** | PRJ0019818 |
| **Airgas × Americas:** a descrição diz que Airgas é "key entity within the Americas hub", mas a hierarquia não é aplicada | Airgas em 21 projetos, só 8 também com Americas |
| **Listas "touched" × claims:** `dds_entities_touched` e `gio_services_touched` são geradas à parte e divergem | 80 de 259 entidades "touched" sem nenhum claim; em 8 de 69 projetos, GIO touched ≠ alvos GIO dos claims |
| **PGM0001209** (o do seu screenshot) | 5 DDS "touched" (Europe, CF, E&C, HHC, Industrial Apps), só **1** claim DDS (Europe) |
| **InnoTech:** a descrição diz que é agrupamento futuro, "remain distinct" em 2026 | marcada em 5 projetos, com 3 claims. **Correção (§3.1, item 4):** a GBU InnoTech existe desde março de 2025, então o modelo acertou e o erro está no catálogo |

**Proposta:** injetar um cartão curto por entidade canônica no prompt de Goals, através de um placeholder `{{TARGET_CATALOG}}` gerado do JSON. Cada cartão traz escopo em 1-2 linhas, sinais típicos, o que *não* é daquela entidade, papéis típicos e, para DDS, a entidade-mãe. Com 25 entidades e ~300 caracteres cada, são ~7,5 mil caracteres, contra até 300 mil de documentos por projeto (`goals-extractor.ts:26`). O mesmo placeholder substitui a lista de GIO escrita à mão no prompt de Impact (§2.5). **Depende de reescrever o catálogo antes (§2.4).**

### 2.4 Conteúdo do catálogo

**GIO Service Lines**

| Problema | Onde |
|---|---|
| **28 nomes de pessoas** em organogramas: 9 em Security & Compliance, 7 em Command Center, 8 em User Workplace, 4 em Site Infrastructure. Não ajudam a classificar, ficam desatualizados e são dados pessoais enviados ao LLM a cada Deep Dive. | `target-catalog.data.json` |
| **Artefatos de cópia:** marcadores de nota colados ("local proximity:1", "contracts.1", "watches.1") e frase cortada ("bot management for critical applications through.") | Security & Compliance |
| **Fatos com data de validade:** campanha de snapshots de "$200,000 annually", "decommissioning of the legacy Ivanti… October 2026", "pilot… mid-2026", roadmap 2027–2030 | Cloud Services, User Workplace |
| **Sobreposições sem regra de desempate:** Zscaler Private Access aparece em Security & Compliance ("transitioning to SSE and ZPA") **e** em User Workplace ("replacing traditional VPNs with Zscaler Private Access"); Wi-Fi aparece em Site Infrastructure **e** em Cloud Services ("Wifi on the Cloud"). Fronteiras decididas: ZPA/VPN (§3.1, item 6), Wi-Fi e firewalls (item 9) | S&C × UW; Site × Cloud; S&C × Site |
| **Duas definições diferentes da mesma SL:** o prompt de Impact (`prompts.ts:175-179`) diz que Cloud Services é "G&SM/Service Catalog, E&I S/4 HANA Upgrade, T&O Problem management, APAC Citrix Developer workspace, SAP Basis operations"; o catálogo diz "multi-cloud strategy… AWS and GCP… FinOps". User Workplace no prompt: "ComputaCenter on-site support, Packaging factory"; no catálogo: "Google Workspace… Zscaler Private Access" | prompt de Impact × catálogo |
| **Site Infrastructure sem o que ela opera:** a descrição lista liderança e regiões, mas quase nenhum serviço concreto | Site Infrastructure |

**Entidades DDS**

| Problema | Onde |
|---|---|
| Descrições de uma linha, sem nada que diferencie; **15 de 20** sem `typicalRoles`/`typicalImpactTypes` | todas, exceto as 4 regiões e CDIO Office |
| **Siglas por extenso erradas** (§3.1, itens 1 e 5):<br>• **GDO** está descrita como "Global Digital Organization"; o certo é Global Data Operations, entidade dentro de GDS.<br>• O subtítulo em `/admin/catalog` chama GDS de "Global Digital Services"; o certo é Global Delivery Services, o grupo guarda-chuva.<br>• Os prompts chamam DDS de "Digital & Data Solutions"; o certo é Digital Delivery Services, que aparece nos documentos de 16 projetos (a outra forma não aparece em nenhum). | `target-catalog.data.json:113`, `catalog/page.tsx:39`, `prompts.ts:20`, `deep-dive-engine.ts:235` |
| **Hierarquia implícita, sem campo `parent`:** Airgas dentro de Americas (§3.1, item 2); GDO, Industrial Apps, Data & AI Apps e Digital Factory dentro de GDS (§3.1, itens 1 e 10) | Airgas, GDO, Industrial Apps, Data & AI Apps, Digital Factory |
| **Fronteira indefinida:** HHC (Home Healthcare) × HC D&IT (Healthcare D&IT). A regra está no §3.1, item 3 | HHC, HC D&IT |
| **Recortes regionais que não batem:** a DDS separa Europe e AMEI; os gerentes regionais das GIO cobrem "Europe, Africa, Middle-East & India" (EAMEI). A regra está no §3.1, item 5 | DDS × GIO |
| **Organização desatualizada:** E&C ("separate DDS entity from InnoTech for the 2026 roadmap"), IDD ("separate DDS from the InnoTech umbrella") e InnoTech ("planned to eventually integrate") descrevem uma fusão que já aconteceu (§3.1, item 4) | E&C, IDD, InnoTech |
| **Campo `dds` dos projetos fora do canônico:** `GIO` (28 projetos), `Indutrial Apps` (15), `Entreprise Apps` (6), vazio (5), `Digital & AI` (3). O `normalizeDds` existe (`dds-catalog.ts`) mas não é aplicado a `projects.dds`, e `DDS_COLORS` (`constants.ts`) tem os erros de digitação como chave, o que esconde o problema | tabela `projects` |

**Proposta de formato por entrada.** São campos novos no JSON e na tela de admin. Nada de nomes de pessoas nem campanhas datadas: se for útil manter esse contexto, ele vai para um campo `notes` que não é injetado em prompt.

```json
"Security & Compliance": {
  "scope": "Designs, builds and operates the Group's security solutions: identity and access, network security, cloud security posture, application protection, server compliance and certificates.",
  "signals": ["CARM", "AdminPass", "PAM", "SWG", "SSE", "ZPA", "ZTNA", "Ivanti VPN migration", "Prisma Cloud", "Cortex Cloud", "XSIAM", "WAAP", "GT04", "Qualys", "PKI", "Sectigo", "CSIRT", "DRMT"],
  "not_this": "End-user devices and workplace software → User Workplace. LAN, WAN, Wi-Fi, Cisco ISE and on-site/branch firewalls (WAN rules, site edge) → Site Infrastructure (formerly GIO Network & Telecom).",
  "typicalRoles": ["primary_provider", "risk_owner"],
  "typicalImpactTypes": ["security_dependency", "infrastructure_shared"],
  "notes": "Org chart, leaders and 2026 transitions — reference only, never sent to the LLM."
}
```

Os `signals` vieram do texto atual da descrição e das respostas 6 e 9 (§3.1). "Firewall" sozinho não é sinal de Security & Compliance: os de site são de Site Infrastructure. S&C fica com arquitetura de segurança, gestão de vulnerabilidades e CSIRT.

### 2.5 O prompt de Impact se contradiz

| Contradição | Onde |
|---|---|
| Proíbe linhas com `"target": "GIO_SERVICES"` / `"DDS_IMPACTS"`… | `prompts.ts:181-184`, `212-213` |
| …mas o schema permite esses alvos e **os dois únicos exemplos** são exatamente essas linhas | `prompts.ts:231`, `242-243` |
| O bloco de cada projeto diz *"emit one impact row per claim, do not invent extras"*, e o prompt diz *"DO NOT re-emit"* | `impact-engine.ts:696` × `prompts.ts:213` |
| Manda mapear `parallel → "requires_coordination"` como **`impact_type`**, mas esse valor é de `direction`. 6 linhas ficaram gravadas assim, e hoje o parser descarta essas linhas (`impact-engine.ts:930-937`). `parallel` é o tipo de relação mais comum (9 de 21) | `prompts.ts:203` |
| *"You MUST … find impact relationships"* e *"Find at least the obvious connections"* empurram a emitir algo, e nada diz que `[]` é uma resposta válida para um lote | `prompts.ts:164`, `228` |
| Nenhum dos 11 `impact_type` tem definição: o modelo escolhe entre `platform_shared` e `infrastructure_shared` sem critério | `prompts.ts:232` |
| A lista de serviços GIO diverge do catálogo (§2.4) | `prompts.ts:175-179` |

O parser já protege o banco, descartando pseudo-alvos e tipos fora do vocabulário. O custo real está em tokens gastos em linhas jogadas fora e num modelo instruído a fazer duas coisas opostas.

**Proposta:**

1. O schema passa a aceitar só alvo = projeto, com exemplos projeto → projeto que tragam citação.
2. Apagar a instrução contraditória em `impact-engine.ts:696`.
3. Uma linha de definição para cada `impact_type`, compartilhada com o prompt de Goals.
4. Mapear `parallel → organizational` + `requires_coordination`.
5. Trocar "find at least" por "return [] when no pair meets the bar".
6. As 21 de 21 relações já viram impacto; ainda assim, materializá-las no código, como os claims, tira essa dependência do modelo e esse texto do prompt.

### 2.6 Citações que não resolvem

| Medida | Valor |
|---|---|
| Claims cujo `evidence_file` não casa com nenhum arquivo do `documents_cache`, mesmo após normalização | 43 de 181 |
| Linhas GIO/DDS materializadas sem citação | 140 de 279 (DDS 82/154, GIO 58/125) |
| Linhas projeto → projeto sem citação | 178 de 227 |
| Citações projeto → projeto com `doc_url` que não existe no cache | 22 de 52 |
| Das citações com `doc_url` válido, trecho encontrado literalmente | 30 de 30 |
| Citações de claims não encontradas no texto do cache | 13 de 181 |

**Causa observada:** o Goals lê os arquivos locais em `data/drive/<projeto>` (`goals-scanner.ts`, `DRIVE_LOCAL_ROOT`), com o cabeçalho `--- FILE: nome ---` (`goals-extractor.ts:57`). A materialização e o Impact procuram o arquivo no `documents_cache` (`impact-engine.ts:1123`), que é outra fonte, com outros nomes. Exemplo: o claim cita `CIOO-Archiv_Q&A_(Zero-Trust_Network_Access_-_PRJ0010712).txt`, e esse arquivo não existe no cache de PRJ0010712. As 13 citações não encontradas provavelmente estão só nos arquivos locais. Isso não foi verificado.

**Validação ausente:** `parseImpactResponse` aceita qualquer `doc_url` não vazio (`impact-engine.ts:892-898`).

**Regra que atrapalha:** "FIRST SENTENCE of the supporting paragraph" (`prompts.ts:75,104,221`) obriga a citar a primeira frase do parágrafo, que muitas vezes não é a que sustenta o claim (listas, tabelas).

**Proposta:**

1. Uma fonte só de documentos para Goals, Impact e Deep Dive, ou pelo menos um índice que resolva o nome local para a entrada do cache.
2. O servidor valida `doc_url` contra os documentos do projeto e marca o trecho como verificado ou não.
3. Trocar a regra por "the sentence that supports the claim, verbatim, ≤ 200 chars".

### 2.7 Campos do Goals redundantes ou ambíguos

| Campo | Situação | Proposta |
|---|---|---|
| `dds_entities_touched`, `gio_services_touched` | Gerados à parte dos claims e divergentes (§2.3) | Derivar dos alvos dos claims no código e deixar de pedir ao modelo |
| `gio_sl_dds_impacts` | O prompt diz que os claims o substituem (`prompts.ts:96`), mas ele continua sendo pedido, exibido e enviado ao Impact | Manter só como resumo humano, gerado *a partir dos claims* ("summarize the claims above in 2–4 sentences"), para não contradizê-los |
| `ia_embedded` | 48% "Not identified", enquanto outros textos dizem "No AI embedded", misturando "o documento diz que não" com "o documento não fala" | Novo campo `ia_embedded_status: "yes" \| "no" \| "not_documented"` + o texto |
| `tech_tags`, `vendors`, `data_classifications` | O modelo filtra sozinho (só 1 descarte), então as lacunas de vocabulário não aparecem. O próprio catálogo cita termos ausentes: `google-workspace` (User Workplace diz "Google Workspace", e o vocabulário só tem a família Microsoft), `qualys`, `sectigo`, `nexthink`, `ivanti`, `citrix`, `computacenter` (vendor) | Campo `unmapped_terms` (não exibido) para descobrir lacunas; incluir os termos acima depois de confirmados |

### 2.8 Parâmetros de geração

| Chamada | Modo JSON | Temperatura |
|---|---|---|
| Goals (`goals-analyzer.ts:533`) | não | padrão do modelo |
| Impact (`impact-engine.ts:1293`) | sim | padrão do modelo |
| Deep Dive (`deep-dive-engine.ts:541`) | não (markdown) | definida |
| Planning (`project-planning-engine.ts:555`) | sim | definida |

Hoje nenhuma resposta de Goals falhou no parse, mas extração é tarefa analítica: rodar de novo sobre os mesmos documentos não deveria mudar alvos e severidade. **Proposta:** modo JSON e temperatura baixa em Goals e Impact, como Deep Dive e Planning já fazem.

### 2.9 Listas canônicas copiadas em seis lugares

| Lista | Cópias |
|---|---|
| Entidades DDS | `prompts.ts` (Goals e Impact), `target-catalog.ts`, `dds-catalog.ts`, `tech-catalog.ts` |
| GIO Service Lines | `prompts.ts` (Goals e Impact), `target-catalog.ts`, `tech-catalog.ts` |
| `impact_type` | `prompts.ts` (claims: 10 valores; Impact: 11), `target-catalog.ts` (11), `goals-analyzer.ts` (10) |
| Papéis | `prompts.ts`, `target-catalog.ts`, `goals-analyzer.ts`, `catalog/page.tsx` (com outro significado, §2.1) |

A divergência já existe: `data_dependency` é aceito em impactos, mas não em claims, sem comentário que diga se isso é intencional.

Além disso, o prompt é texto fixo: editar o catálogo em `/admin/catalog` não muda o que o modelo vê.

**Proposta:** os prompts passam a ter placeholders preenchidos a partir do código a cada chamada (`{{DDS_LIST}}`, `{{GIO_LIST}}`, `{{TARGET_CATALOG}}`, `{{TECH_CATALOG}}`, `{{IMPACT_TYPES}}`, `{{ROLES}}`), com uma única fonte por lista.

Isso depende da decisão pendente sobre o `data/prompts.json`, registrada em `PLAN_USER_PREFERENCES_AND_AUDIT.md` §5. Hoje o arquivo não existe, então o código vale. O primeiro salvamento pela tela congelaria o texto e ignoraria estas melhorias.

### 2.10 Deep Dive, Planning e detalhes

- **Deep Dive:** manter. A única mudança é receber o cartão reescrito do catálogo (§2.4), sem organograma. Hoje ele injeta a descrição inteira, com os 28 nomes.
- **Planning:** manter como está.
- **Rótulos desatualizados:** "Gemini 2.0 Flash" em `DetailPanel.tsx:277` e `stages.ts:409,426,515`, quando o modelo real é `gemini-3.1-pro-preview`.

---

## 3. Respostas do negócio e decisões

As respostas definem as fronteiras que o modelo vai aplicar. Duas regras valem ao levar esse conteúdo para o catálogo:

- **Sem nomes de pessoas:** eles ficam fora do catálogo (§2.4).
- **Sem marcadores de nota colados:** números de referência grudados no texto ("…organizacional.1", "…unificada.12") são o mesmo artefato encontrado hoje na descrição de Security & Compliance.

### 3.1 Decidido (2026-09-14)

**1. GDS × GDO**

- **Resposta:** GDS é Global Delivery Services, o modelo e grupo guarda-chuva. GDO é Global Data Operations, uma entidade operacional dentro de GDS. A GIO Account Factory, por exemplo, lista como entidades GDS: GDO, Industrial Apps e GIO.
- **O que muda:**
  - corrigir a descrição de GDO;
  - GDS **não** vira alvo de impacto: é agrupamento, e entra como `parent` de GDO e Industrial Apps;
  - corrigir "Global Digital Services (GDS)" em `catalog/page.tsx:39`.

**2. Airgas**

- **Resposta:** Airgas faz parte de Americas e está integrada à estrutura organizacional da região: DRMT de Americas, MyHR (Workday) implantado junto com LATAM sob Americas, compras digitais coordenadas pelo Americas Procurement Center.
- **O que muda:**
  - `parent: "Americas"`;
  - um claim em Airgas não gera um segundo claim em Americas: é a agregação no código (listas "touched", filtros, Universe) que soma Airgas dentro de Americas;
  - hoje, 13 de 21 projetos marcam Airgas sem Americas.

**3. HHC × HC D&IT**

- **Resposta:**
  - **HHC** é a GBU de negócio global: operações, excelência operacional, programas como TechCARE e Data Healthcare. É onde nascem as necessidades.
  - **HC D&IT** é a função de TI dedicada ao vertical Healthcare: liderança tecnológica (IT Leader), validação de arquitetura, conformidade com os padrões globais de segurança e de compras de TI.
- **Regra do cartão:**
  - impacto em processo, usuários, operação ou programa de negócio → **HHC**;
  - impacto em entrega de TI, arquitetura, ferramentas (DevOps, Salesforce, ERP das filiais) ou conformidade técnica → **HC D&IT**.
- Um projeto HHC típico toca os dois, com papéis diferentes. O nome "DDS HHC" está resolvido no item 8.

**4. InnoTech**

- **Resposta:**
  - A GBU InnoTech está ativa desde a Fase 1 do projeto FIT (17/03/2025), como fusão da GBU IDD com a GBU E&C.
  - Na Fase 2B (go-live em 14/09/2026): BIS E&C passou a se chamar DDS InnoTech; os grupos de TI mudaram de BEC para DIN; os grupos GM&T (IDD) mudaram de BGMT para DIN.
  - O provedor BIS GM&T continua ativo temporariamente.
- **O que muda:**
  - E&C e IDD deixam de ser alvos próprios e viram **aliases de InnoTech**, porque documentos antigos continuam dizendo E&C/IDD;
  - GM&T continua canônico por enquanto;
  - reescrever as descrições de E&C, IDD e InnoTech.
- **Tamanho da migração:** 3 projetos com dono E&C, 6 marcações "touched" (E&C 5, IDD 1), 1 claim e 2 impactos.

**5. Europe × AMEI × EAMEI**

- **Resposta:** na GIO, EAMEI é uma direção regional unificada. Abaixo dela, a entrega é separada para AMEI e para Europe; esta última, por clusters (França; Norte e Sudoeste; Central e Leste). Os pontos de contato de engajamento são por domínio DDS: Europe, AMEI, HHC, SEPPIC, CF, InnoTech e Industrial Apps.
- **O que muda:**
  - a DDS mantém Europe e AMEI separados;
  - "EAMEI" num documento não marca os dois automaticamente: marca só o que o texto identificar por país ou site, e marca ambos só quando o escopo for EAMEI inteiro;
  - fica confirmado que **DDS = Digital Delivery Services**, então é preciso corrigir `prompts.ts:20` e `deep-dive-engine.ts:235`.

**6. Acesso remoto e Wi-Fi**

- **Resposta:**
  - A migração do VPN Ivanti para Zscaler ZPA (ZTNA) está sob Security Engineering & Innovation, na GIO.
  - Wi-Fi, LAN, WAN e Cisco ISE estão sob GIO Network & Telecom (serviço WAN/LAN/Wi-Fi e engenharia de redes).
- **O que muda:**
  - ZPA/VPN passa a pertencer a **Security & Compliance** e sai de User Workplace como dono (proposta: User Workplace fica, no máximo, como consumidora do rollout aos usuários);
  - Wi-Fi sai de Cloud Services ("Wifi on the Cloud" é roadmap, não dono);
  - Network & Telecom e firewalls: item 9.

**7. Projetos com dono "GIO"**

- **Resposta:** aceitar "GIO" como dono válido de projeto.
- **O que muda:**
  - "GIO" entra como valor válido no campo de entidade dona dos 28 projetos (filtros, cores);
  - **não** vira alvo de impacto DDS, porque impactos na GIO continuam indo para as cinco service lines;
  - GIO também é entidade GDS (item 1).

**8. DDS HHC × HC D&IT**

- **Resposta:** não são o mesmo termo, mas se referem à mesma vertical sob óticas diferentes.
  - **HC D&IT** é a função e vertical de governança tecnológica da área de saúde.
  - **DDS HHC** é o nome oficial da estrutura que fornece os serviços de TI (service provider), desde o go-live da Fase 2 do FIT (14/09/2026). Antes se chamava BIS Home Healthcare, e o trigrama passou a ser DHC.
- **O que muda:**
  - a entidade canônica **HHC** representa o vertical Home Healthcare do lado de negócio e de entrega: a GBU HHC (item 3) e o provedor DDS HHC;
  - "DDS HHC", "BIS Home Healthcare", "Home Healthcare" e o trigrama "DHC" viram **aliases de HHC**;
  - **HC D&IT** fica para governança tecnológica: liderança de TI, validação de arquitetura, conformidade com padrões globais.
- **Aplicando ao exemplo real:** o PRJ0019818 cita "DDS HHC: support / Expertise on the interface between HHC solutions and Payroll", que é suporte do provedor, então o alvo é **HHC**. O modelo gravou HC D&IT. Essa é uma aplicação da regra, e vale conferir no conjunto de referência (Fase B).

**9. GIO Network & Telecom e firewalls**

- **Resposta:** Network & Telecom não é uma sexta service line. Ela foi reestruturada e passou a se chamar **Site Infrastructure**; os dois nomes aparecem nos documentos por causa da transição. Os firewalls foram divididos:
  - firewalls locais e de filiais, regras de WAN e borda de site → Site Infrastructure;
  - gestão de vulnerabilidades corporativas, arquitetura de segurança e CSIRT → Security & Compliance.
- **O que muda:**
  - "GIO Network & Telecom" e "GIO N&T" viram **aliases de Site Infrastructure**;
  - Wi-Fi, LAN, WAN e Cisco ISE entram nos `signals` de Site Infrastructure;
  - a descrição de Security & Compliance para de dizer que "opera firewalls" sem qualificar.

**10. Data & AI Apps e Digital Factory**

- **Resposta:** as duas estão dentro de GDS (também chamada GDDS), assim como as estruturas do ecossistema GDO.
- **O que muda:**
  - `parent: "GDS"` para Data & AI Apps e Digital Factory, além de GDO e Industrial Apps (item 1);
  - "GDDS" vira alias de GDS;
  - **não confirmado:** o `parent` de Enterprise Apps, CDIO Office e InnoTech. O agrupamento da tela `/admin/catalog` continua só visual e não vira regra para o modelo.

**11. Perímetro de DDS Europe**

- **Resposta:** para DDS Europe vale o modelo de clusters de negócio, que rege faturamento, carteira de clientes e portfólio de TI: CE (Central Europe), SWE (South-West Europe) e NEC (North-East Europe).
- **O que muda:**
  - a descrição atual de Europe fica;
  - os clusters de entrega da GIO (item 5) não entram no cartão de DDS Europe.

**12. Regra geral de nomes antigos (consequência dos itens 4, 8 e 9)**

- A onda de renomeações do FIT trocou o prefixo BIS por DDS e mudou trigramas, e a GIO também renomeou Network & Telecom.
- Documentos anteriores a essas mudanças usam os nomes antigos. Por isso o catálogo ganha um campo `aliases` por entidade, aplicado em três lugares:
  - na normalização (`dds-catalog.ts`);
  - no sanitizador de claims;
  - como sinal no cartão enviado ao modelo.
- **Aliases já conhecidos:**
  - "BIS E&C", "E&C", "IDD", "DIN", "BEC" → InnoTech;
  - "BIS Home Healthcare", "DDS HHC", "DHC" → HHC;
  - "GIO Network & Telecom", "GIO N&T" → Site Infrastructure;
  - "GDDS" → GDS.
- **GM&T:** os grupos IDD de GM&T foram para InnoTech (DIN), mas o provedor BIS GM&T segue ativo. "BGMT" não vira alias até esse provedor ser encerrado.
- **O que os documentos atuais usam** (contagem no cache, 2026-09-14):

  | Forma | Projetos |
  |---|---|
  | "DDS <entidade>" | 33 |
  | "BIS <entidade>" | 6 |
  | "GDDS" | 5 |
  | "BIS Home Healthcare" | 0 |
  | Trigramas DHC / DIN / BEC / BGMT | 0 |

- **Como usar os aliases:**
  - os nomes com prefixo (BIS/DDS) e "GDDS" servem como sinal no texto livre;
  - os **trigramas** ficam só para normalizar campos estruturados (planilhas, grupos de TI) e nunca como sinal em texto livre, porque siglas de três letras colidem com outras coisas ("DIN" também é a norma técnica alemã).

### 3.2 Ainda em aberto

Nenhuma pergunta bloqueia a reescrita do catálogo. Resta só o detalhe não confirmado do item 10: o `parent` de Enterprise Apps, CDIO Office e InnoTech.

---

## 4. Proposta em fases

### Fase A: corrigir sem chamar o LLM

- §2.1: trocar o mapeamento de papel → direção, recalcular `direction` das linhas existentes, remover linhas GIO/DDS órfãs e corrigir o `ROLE_HELP`.
- §2.5: corrigir as contradições e os exemplos do prompt de Impact.
- §2.6: validar `doc_url` no servidor.
- §2.10: rótulos e comentários desatualizados.

**Critério de pronto:** nenhuma narrativa "provides services to" nascida de `primary_provider`; PRJ0022184 com uma linha GIO por claim; zero `doc_url` inexistente em citações novas.

**✅ Aplicada em 14/09/2026.**

- **Código:**
  - `ROLE_TO_DIRECTION` invertido para ler a partir do alvo (`impact-engine.ts`);
  - linhas GIO/DDS **substituídas** a cada rodada em vez de só acrescentadas (`replaceMaterialisedClaimRows`);
  - citações com `doc_url` fora dos documentos do lote são descartadas (`dropUnknownCitations`);
  - prompt de Impact sem as contradições: alvo só projeto, exemplos projeto → projeto, `parallel → organizational`, definição de cada `impact_type`, `[]` válido, lista GIO alinhada ao §3.1;
  - instrução de papéis do Goals com a perspectiva explícita;
  - `ROLE_HELP` e comentários corrigidos;
  - rótulos "Gemini 2.0 Flash" removidos.
- **Dados:** `scripts/rematerialize-claims.cjs --apply`, depois do deploy, com backup em `data/cioo.db.bak-rematerialize-2026-09-14T10-47-14-752Z`.

| Verificação (consulta no `cioo.db`) | Antes | Depois |
|---|---:|---:|
| Linhas GIO/DDS | 279 | 181 |
| Linhas GIO/DDS sem claim correspondente | 98 | 0 |
| Direção divergente do mapeamento corrigido | 102 | 0 |
| `provides_to` vindo de `primary_provider` | 89 | 0 |
| Linhas GIO de PRJ0022184 (3 claims) | 7 | 3 |
| Linhas projeto → projeto (não tocadas) | 227 | 227 |

Frase de PRJ0022184 agora: *"Reinforcement of High Privilege Accesses and Environments **depends on** Security & Compliance."*

**Pendente de observação:** a validação de `doc_url` só age na próxima rodada de Impact, que vem do agendador quando entrar goal novo ou de uma execução manual. Conferir no log a linha `dropped N citation(s)` e, no banco, zero citações novas com link inexistente.

**Não entrou na Fase A** (fica para a C): corrigir as siglas por extenso (`prompts.ts:20`, `deep-dive-engine.ts:235`, `catalog/page.tsx:39`) e os aliases.

### Fase B: conjunto de referência

Separar 10 projetos que cubram casos variados: muito GIO, muito DDS, documentação pobre, várias regiões, PGM0001209 e PRJ0019818. Para cada um, uma pessoa registra os alvos, papéis e severidades esperados. Um script compara a extração com esse gabarito e com as métricas do §5.

**Critério de pronto:** gabarito revisado e métricas da versão atual (v4) calculadas sobre ele.

### Fase C: reescrever o catálogo

Todas as fronteiras estão decididas (§3.1).

- formato `scope` / `signals` / `not_this` / `parent` / `aliases` / `notes`;
- sem nomes de pessoas e sem campanhas datadas;
- os mesmos campos na tela `/admin/catalog`;
- **decisões do §3.1:**
  - `parent`: Airgas → Americas; GDO, Industrial Apps, Data & AI Apps e Digital Factory → GDS;
  - aliases do item 12 (BIS/DDS, trigramas, Network & Telecom, GDDS);
  - regras HHC × HC D&IT (itens 3 e 8) e EAMEI (item 5) nos cartões;
  - ZPA/VPN em Security & Compliance; Wi-Fi, LAN, WAN, Cisco ISE e firewalls de site em Site Infrastructure; arquitetura de segurança, vulnerabilidades e CSIRT em Security & Compliance;
  - Europe com os clusters CE / SWE / NEC;
  - reescrever GDO, E&C, IDD e InnoTech;
  - corrigir as siglas por extenso em `prompts.ts:20`, `deep-dive-engine.ts:235` e `catalog/page.tsx:39`;
- **E&C e IDD como aliases de InnoTech:**
  - entram no mapa de aliases (`dds-catalog.ts`) e no sanitizador de claims;
  - migram os dados existentes: 3 donos, 6 marcações "touched", 1 claim, 2 impactos;
  - a chave UNIQUE dos impactos inclui `dds_entities`, então é preciso deduplicar se já houver a mesma aresta com InnoTech;
- normalizar `projects.dds` na importação: aliases, erros de digitação ("Indutrial Apps", "Entreprise Apps", "Digital & AI") e "GIO" aceito como dono (§3.1, item 7).

### Fase D: prompt de Goals v5

- cartões do catálogo (§2.3);
- rubrica de severidade (§2.2);
- papéis com a perspectiva explícita (§2.1);
- listas "touched" derivadas dos claims (§2.7);
- `ia_embedded_status` e `unmapped_terms`;
- regra da frase que sustenta o claim (§2.6);
- modo JSON e temperatura baixa (§2.8);
- placeholders gerados do código (§2.9).

Validar primeiro no conjunto de referência. Só depois subir `GOALS_PROMPT_VERSION`, o que reprocessa todo o portfólio: pela média medida em `llm_calls`, ~43 s por projeto, cerca de 50 minutos para os 69, seguidos de uma rodada completa de Impact.

**Critério de pronto:** o conjunto de referência não piora em precisão de alvo e papel; a proporção de `high` passa a refletir a rubrica; nenhuma entidade "touched" sem claim.

### Fase E: prompt de Impact v2

- placeholder do catálogo;
- definições de `impact_type`;
- relações materializadas no código;
- "[] é válido";
- temperatura baixa.

---

## 5. Linha de base (2026-09-14)

Para comparar antes e depois de cada fase:

| Métrica | Valor |
|---|---|
| Extrações Goals com sucesso / prompt | 69 / v4, `en` |
| Claims / por projeto | 181 / 2,6 |
| Claims `high` | 148 (82%) |
| Papéis | primary_provider 89, regional_executor 42, risk_owner 32, downstream_consumer 13, blocked_by 5 |
| Citações de claim encontradas literalmente no cache | 168 / 181 |
| `evidence_file` que resolve no cache | 138 / 181 |
| Entidades "touched" sem claim | 80 / 259 |
| Projetos com GIO touched ≠ alvos GIO dos claims | 8 / 69 |
| `ia_embedded` "Not identified" | 48% |
| Projetos sem `tech_tags` / `vendors` / `data_classifications` | 22% / 23% / 35% |
| Impactos (GIO / DDS / projeto) | 125 / 154 / 227 |
| Linhas GIO/DDS sem citação | 140 / 279 |
| Linhas projeto → projeto sem citação | 178 / 227 |
| Citações projeto → projeto com `doc_url` inexistente | 22 / 52 |
| Linhas com direção invertida (`provides_to` vindo de `primary_provider`) | 134 |
| `projects.dds` fora do canônico | 57 de 306 projetos (GIO 28, Indutrial Apps 15, Entreprise Apps 6, vazio 5, Digital & AI 3) |
| Tempo médio por chamada (Goals / Impact / Planning / Deep Dive) | 42,8 s / 68,5 s / 45,1 s / 30,6 s |
