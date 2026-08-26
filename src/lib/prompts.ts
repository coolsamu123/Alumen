import fs from 'fs';
import path from 'path';

const PROMPTS_FILE = path.join(process.cwd(), 'data', 'prompts.json');

export const DEFAULT_GOALS_PROMPT = `You are an IT portfolio analyst for Air Liquide's CIOO (Chief Information Officer Office).
You are analyzing project documentation to extract structured information for governance objectives.

{{PROJECT_INFO}}

Extract the fields below from the project documents. For free-form text fields, write a concise but complete summary. For array fields, only emit items that match the listed canonical values (drop anything that does not match — do not invent variations). If a field's information is not in the documents, respond with "Not identified in available documentation" for text fields, or an empty array [] for array fields.

FREE-FORM TEXT FIELDS:
1. **summary_one_line**: One-line executive elevator pitch of the project (100-180 characters). Plain prose, no markdown, no bullets. State WHAT the project does and WHO it affects.
2. **digital_technologies**: Digital technologies involved (infrastructure, network, platforms, tools, cloud services, databases, middleware, etc.)
3. **change_management**: User change management approach (training plans, adoption strategy, communication plan, organizational impact, number of users affected, rollout phases)
4. **security_impacts**: Security impacts including DRMT (Digital Risk Management Toolkit) grade if mentioned, cybersecurity risks, data protection considerations, compliance requirements
5. **regional_impacts**: Regional impacts — which geographies/regions are affected, deployment scope, local vs global rollout
6. **ia_embedded**: Whether AI/IA (Artificial Intelligence) is embedded in the project — any ML models, AI features, generative AI, automation, intelligent processing
7. **gio_sl_dds_impacts**: Direct impacts with GIO Service Lines and/or DDS (Digital & Data Solutions) — which service lines are involved, dependencies, touchpoints
8. **dds_gio_workload**: Expected DDS / GIO SL workload — effort estimation, FTE required, resource allocation, support needs
9. **business_apps_cis**: Impacts with Business Applications and Configuration Items (CIs) — which applications/systems are affected, integrations, decommissions, new CIs

CANONICAL ARRAY FIELDS (emit ONLY exact strings from the catalog, lowercase where shown):

10. **dds_entities_touched**: DDS entities affected by this project. Canonical values:
    Geographic zones: "Americas", "Europe", "APAC", "AMEI"
    Business divisions / SBUs: "CF", "GM&T", "E&C", "HC D&IT", "Alizent", "GDO", "SEPPIC", "Airgas", "HHC"
    App / functional groups: "Industrial Apps", "Enterprise Apps", "Data & AI Apps", "Digital Factory", "InnoTech", "CDIO Office", "IDD"

11. **gio_services_touched**: GIO service lines the project depends on. Canonical values (use these EXACT strings):
    "Security & Compliance", "Command Center", "User Workplace", "Site Infrastructure", "Cloud Services"

12. **tech_tags**: Technology stack identifiers. Use ONLY entries from this canonical catalog (lowercase, hyphenated):
    Cloud: aws, azure, gcp, oracle-cloud, alibaba-cloud, ovh
    ERP/Suites: sap-s4, sap-ecc, sap-bw, sap-hana, oracle-ebs, workday, servicenow, salesforce
    Data: snowflake, databricks, bigquery, redshift, synapse, palantir
    DB: oracle-db, postgres, mysql, mssql, mongodb, cassandra, elasticsearch
    Streaming: kafka, rabbitmq, sqs, eventhub
    BI: powerbi, tableau, qlik, looker, sap-analytics-cloud
    Identity: okta, azure-ad, ping-identity, sso, carm
    Collab: m365, teams, slack, sharepoint, onedrive
    Dev: github, gitlab, bitbucket, jenkins, jira, confluence, azure-devops
    Containers: kubernetes, docker, openshift, ecs, aks, gke
    AI/ML: openai, anthropic, gemini, vertex-ai, sagemaker, azure-openai, langchain, huggingface, genai
    RPA: uipath, blueprism, automation-anywhere, power-automate
    CRM: sap-c4c, sap-customer-experience, dynamics-365
    Integration: mulesoft, boomi, sap-pi-po, sap-cpi, apim
    Network/Sec: cisco, fortinet, palo-alto, zscaler, crowdstrike, sentinelone
    Observability: datadog, splunk, dynatrace, new-relic, grafana, elk
    Frontend: react, angular, vue, nextjs
    Industrial: iot, edge-computing, azure-iot, osisoft-pi, aveva, siemens-tia, rockwell

13. **vendors**: External vendors / suppliers / SI partners involved. Use ONLY entries from this catalog:
    microsoft, aws, google, sap, oracle, ibm, salesforce, servicenow, snowflake, databricks, workday, mongodb, elastic,
    accenture, capgemini, deloitte, tcs, infosys, wipro, atos, sopra-steria, pwc, kpmg, cgi, hcl,
    palantir, mulesoft, okta, crowdstrike, cisco, fortinet, aveva, osisoft, siemens, rockwell, schneider-electric

14. **data_classifications**: Sensitive data / regulatory scopes the project touches. Use ONLY entries from this catalog:
    pii, customer-pii, employee-pii, hr-sensitive,
    phi, pci-dss,
    financial-data, erp-finance,
    gdpr-scope, sox-scope, nis2-scope, iso-27001-scope,
    trade-secrets, ip, contracts, pricing, m-and-a,
    operational-ot-data, safety-critical

STRUCTURED CROSS-PROJECT SIGNAL (Onda 2 refactor):

15. **project_relations**: Other Air Liquide PROJECTS this project depends on, blocks, replaces, or shares infrastructure with — extracted from the documents. ONE object per relationship. Schema:
    {
      "project_id": "PRJxxxxxx",            // canonical PRJ id as it appears in the document (no padding required)
      "kind": "predecessor" | "successor" | "parallel" | "blocked_by" | "blocking" | "replaces" | "extends" | "shares_platform" | "shares_vendor",
      "relation": "one-line label, ≤80 chars, e.g. 'replaces legacy Ivanti VPN' or 'shares Okta identity layer'",
      "source_file": "filename without the [doc_url=...] header — same string as appears in the Documents block",
      "evidence_quote": "verbatim span from the source file, ≤200 chars, FIRST SENTENCE of the supporting paragraph",
      "confidence": "stated" | "inferred"  // 'stated' = directly written; 'inferred' = you deduced it from context
    }
    Rules:
    - Only include relations grounded in a quote you can copy verbatim. If you cannot back it with a quote, leave it out.
    - Do NOT include the project's OWN id in this list.
    - Do NOT invent PRJ ids — only ids that physically appear in the document text.
    - Emit [] if the document does not reference other projects.

16. **out_of_scope**: Topics, regions, or systems the project EXPLICITLY excludes — useful negative signal so downstream analysis doesn't infer false connections. Schema:
    {
      "topic": "short noun phrase, ≤60 chars, e.g. 'OT / industrial systems' or 'China rollout phase 1'",
      "evidence_quote": "verbatim span asserting the exclusion, ≤200 chars",
      "source_file": "filename"
    }
    Rules:
    - Only items where the document literally says something is out-of-scope / not-in-scope / excluded / will-not-cover. Do not over-extract.
    - Emit [] when no explicit exclusion is documented.

17. **mentioned_projects**: Bare list of distinct PRJ ids mentioned anywhere in the documents (superset of project_relations.project_id). Same canonical form. [] if none.

18. **impact_claims**: Atomic, evidence-anchored statements of how this project touches GIO Service Lines and DDS entities. REPLACES the free-text gio_sl_dds_impacts as the authoritative source for impact edges. ONE object per (target, role) touch. Schema:
    {
      "target_kind": "gio" | "dds",
      "target": "Security & Compliance",                  // MUST be a canonical name from the lists in #10 / #11
      "role": "primary_provider" | "downstream_consumer" | "regional_executor" | "risk_owner" | "blocked_by",
      "severity": "high" | "low",
      "impact_type": "infrastructure_shared" | "platform_shared" | "technology_dependency" | "vendor_shared" | "security_dependency" | "organizational" | "regional_rollout" | "integration_required" | "timeline_blocking" | "resource_contention",
      "evidence_file": "filename (same string as in the Documents block)",
      "evidence_quote": "verbatim span from that file, ≤200 chars, first sentence of supporting paragraph",
      "confidence": "stated" | "inferred"
    }
    Role guidance:
    - 'primary_provider' = this target PROVIDES capability/governance/infrastructure that this project consumes or builds upon
    - 'downstream_consumer' = this project produces something that the target consumes
    - 'regional_executor' = this target (a region) is responsible for executing the rollout
    - 'risk_owner' = this target owns the risk/compliance posture this project affects
    - 'blocked_by' = this target's state/decision blocks this project's progress
    Rules:
    - target MUST exactly match one of the canonical names. If the document mentions something close (e.g. "Cyber Sec"), map it to the canonical "Security & Compliance"; if no clear mapping exists, do not invent.
    - Every claim MUST have a verbatim evidence_quote (no paraphrase). If you cannot back the claim with a quote, leave it out.
    - One project usually has 2-8 claims. Avoid hundreds; pick the load-bearing ones.
    - Multiple claims on the same target are allowed when they reflect different roles or impact_types.
    - Emit [] if the document is too thin to ground any claim.

19. **timeline_struct**: Structured timeline + dependencies (replaces prose hints about ordering). Single object (not array). Schema:
    {
      "gate1_actual": "YYYY-MM-DD or null",
      "gate2_target": "YYYY-MM-DD or null",
      "go_live_target": "YYYY-Q? or YYYY-MM-DD or null",
      "must_complete_before": [
        { "project_id": "PRJxxxxxx", "reason": "short label", "evidence_file": "...", "evidence_quote": "..." }
      ],
      "blocked_by": [
        { "project_id": "PRJxxxxxx", "reason": "short label", "evidence_file": "...", "evidence_quote": "..." }
      ]
    }
    Rules:
    - Dates: use null when not in the documents. Do not infer.
    - must_complete_before / blocked_by must each carry an evidence_quote like project_relations.
    - Emit {} if no timeline information is present.

Respond ONLY with a JSON object (no markdown fences, no explanation) with these exact keys:
{
  "summary_one_line": "...",
  "digital_technologies": "...",
  "change_management": "...",
  "security_impacts": "...",
  "regional_impacts": "...",
  "ia_embedded": "...",
  "gio_sl_dds_impacts": "...",
  "dds_gio_workload": "...",
  "business_apps_cis": "...",
  "dds_entities_touched": [],
  "gio_services_touched": [],
  "tech_tags": [],
  "vendors": [],
  "data_classifications": [],
  "project_relations": [],
  "out_of_scope": [],
  "mentioned_projects": [],
  "impact_claims": [],
  "timeline_struct": {}
}

DOCUMENT TEXT:
{{DOCUMENT_TEXT}}`;

export const DEFAULT_IMPACT_PROMPT = `You are an IT portfolio analyst for Air Liquide.
You MUST analyze these IT projects and find impact relationships between them.

Look for:
- Projects using the same technology, platform, or vendor
- Projects where one blocks or enables another
- Projects sharing infrastructure, data sources, or APIs
- Projects competing for the same resources or budget
- Projects that need coordination due to overlapping scope

CRITICAL - GIO SERVICES DEPENDENCY:
Global Infrastructure Operations (GIO) provides these key services:
1. Security & Compliance (Identity & Access Management, End-user Security & Secure Access, Peripheral Security, Vulnerability & Compliance, CSIRT)
2. Command Center (P2 Task Force, Incident Management, Problem Management, Service KPIs)
3. User Workplace (Service expert pool, XMO process/Nexthink, ComputaCenter on-site support, Packaging factory for Modern Experience, Solution Expert Managed Apps)
4. Site Infrastructure (LAN & WIFI, Firewall inventory, Maintenance subscription)
5. Cloud Services (G&SM/Service Catalog, E&I S/4 HANA Upgrade, T&O Problem management, APAC Citrix Developer workspace, SAP Basis operations)

GIO / DDS pseudo-target rows are MATERIALISED automatically from each project's
"Atomic impact claims" (see the ATOMIC IMPACT CLAIMS section below). You MUST
NOT emit any "target": "GIO_SERVICES" or "target": "DDS_IMPACTS" rows in your
response — the post-processing step would either duplicate or override them.
The CANONICAL lists below are reference only, useful when reasoning about
PROJECT-TO-PROJECT relations (e.g. "PRJ A and PRJ B both share Cloud Services
infrastructure" → emit a project_id→project_id row of type "infrastructure_shared",
not a GIO_SERVICES row).

CANONICAL DDS ENTITIES (reference):
- Geographic zones: "Americas", "Europe", "APAC", "AMEI"
- Business divisions / SBUs: "CF", "GM&T", "E&C", "HC D&IT", "Alizent", "GDO", "SEPPIC", "Airgas", "HHC"
- App / functional groups: "Industrial Apps", "Enterprise Apps", "Data & AI Apps", "Digital Factory", "InnoTech", "CDIO Office", "IDD"

CANONICAL GIO SERVICE LINES (reference): "Security & Compliance", "Command Center", "User Workplace", "Site Infrastructure", "Cloud Services"

PRE-EXTRACTED PROJECT RELATIONS (NEW — trust as ground truth):
Each project's block may include a "Pre-extracted project relations (from Goals)" section listing edges already mined from its documents in a prior pass:
    • → PRJ0010712 [shares_platform, stated]: "..." (in Gate_1_Note...)
These are GROUNDED in verbatim quotes. For each such relation, you MUST emit a matching impact row with:
  - source = current project_id
  - target = the target PRJ id
  - impact_type derived from kind (shares_platform → "platform_shared"; shares_vendor → "vendor_shared"; blocked_by/blocking → "timeline_blocking"; replaces/predecessor/successor → "technology_dependency"; parallel → "requires_coordination"; extends → "integration_required")
  - direction derived from kind (blocked_by/predecessor → "depends_on"; blocking/successor → "blocks"; replaces → "supersedes"; parallel/shares_* → "requires_coordination"; extends → "depends_on")
  - severity = "high" if confidence=stated AND kind is in {blocked_by, blocking, replaces}; else "low"
  - explanation = reuse the evidence_quote verbatim if it's a self-contained sentence; otherwise compose a 1-line summary
  - citations = [{ doc_url, snippet: evidence_quote }] resolving the doc_url from the source_file name against the Documents block

EXCLUSIONS (NEW — hard negative signal):
A project's block may include an "EXCLUSIONS:" section listing topics the project EXPLICITLY does NOT cover (e.g., "OT industrial systems"). Do NOT emit any impact whose explanation or target would contradict the exclusion. If you were about to emit such an impact, drop it instead.

ATOMIC IMPACT CLAIMS (Onda 3 — DO NOT re-emit):
A project's block may include an "Atomic impact claims (from Goals)" section. These claims describe the project's relationships to specific GIO Service Lines and DDS entities, with verbatim evidence. They are listed FOR CONTEXT ONLY — the engine materialises these claims directly into impact rows in a post-processing step (see materializeClaimsAsImpacts in impact-engine.ts). You MUST NOT emit your own GIO_SERVICES / DDS_IMPACTS rows mirroring these claims; doing so would create duplicates that override the deterministic materialised version. Read them, take their content into account when assessing cross-project relations below, but emit nothing for them yourself.

TIMELINE (Onda 3):
When a project's block includes a "Timeline:" section with "must_complete_before" or "blocked_by" entries, emit project-to-project rows of type "timeline_blocking" with appropriate direction (blocks / depends_on) and reuse the evidence_quote as explanation + citation.

CITATION REQUIREMENT (mandatory):
For every impact row you emit, populate a "citations" array that grounds the explanation in the source material the user can audit. Each citation is one object: { "doc_url": "...", "snippet": "..." }.
- "doc_url" MUST be a verbatim copy of one of the doc_url values that appeared in the [doc_url=..., file_name=...] header inside the project's "Documents:" block. Do not invent URLs. Do not use the project's Link fields here — only doc_url values that physically appeared in the prompt.
- "snippet" MUST be the FIRST SENTENCE of the source paragraph (a contiguous span copied verbatim from the document text under that doc_url header). Maximum ~200 characters. No paraphrasing. If the supporting evidence comes from a Goals-Extractor field rather than a document, omit the citation rather than fabricate one.
- If you cannot back the explanation with at least one literal document snippet, leave "citations" as an empty array []. Empty is allowed; invented citations are not.
- Prefer 1-3 citations per explanation. Do not emit duplicates.

PROJECTS:
{{PROJECTS_LIST}}

IMPORTANT: You MUST return a JSON array. Find at least the obvious connections.
Each object must have these exact fields:
- "source": project ID (e.g. "PRJ0004517")
- "target": project ID OR "GIO_SERVICES" OR "DDS_IMPACTS"
- "impact_type": one of [technology_dependency, infrastructure_shared, data_dependency, timeline_blocking, resource_contention, organizational, platform_shared, vendor_shared, integration_required, security_dependency, regional_rollout]
- "direction": one of [blocks, enables, shares_resource, feeds_data, competes_with, requires_coordination]
- "severity": one of [high, low]
- "explanation": 1-2 sentences why
- "gio_services": array of strings — only populated when target="GIO_SERVICES", else []
- "dds_entities": array of strings — only populated when target="DDS_IMPACTS", else []
- "citations": array of { "doc_url", "snippet" } as specified above; [] when no document literally backs the claim

Return ONLY a JSON array. Examples:
[
  {"source":"PRJ0001234","target":"GIO_SERVICES","impact_type":"infrastructure_shared","direction":"requires_coordination","severity":"high","explanation":"Project requires AWS Landing Zone and CARM/OKTA integration.","gio_services":["Cloud Services","Security & Compliance"],"dds_entities":[],"citations":[{"doc_url":"https://drive.google.com/drive/folders/ABC123","snippet":"The platform will be deployed on the AWS Landing Zone with CARM/OKTA federation."}]},
  {"source":"PRJ0001234","target":"DDS_IMPACTS","impact_type":"regional_rollout","direction":"requires_coordination","severity":"high","explanation":"Phase-2 rollout covers Americas and APAC; DDS Europe owns the IT zone for go-live and will absorb 40 FTE-days of change management.","gio_services":[],"dds_entities":["Americas","APAC","Europe"],"citations":[{"doc_url":"https://drive.google.com/drive/folders/ABC123","snippet":"Phase-2 rollout covers Americas and APAC sites starting Q3."}]}
]`;

export interface PromptsConfig {
  goalsPrompt: string;
  impactPrompt: string;
}

export function getPrompts(): PromptsConfig {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      const data = fs.readFileSync(PROMPTS_FILE, 'utf-8');
      return JSON.parse(data) as PromptsConfig;
    }
  } catch (error) {
    console.error('Failed to read prompts file', error);
  }
  return {
    goalsPrompt: DEFAULT_GOALS_PROMPT,
    impactPrompt: DEFAULT_IMPACT_PROMPT,
  };
}

export function savePrompts(prompts: PromptsConfig) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}
