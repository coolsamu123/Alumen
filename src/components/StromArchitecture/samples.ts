// Curated input/output snapshots for each pipeline stage.
// Hard-coded by design — gives reviewers a stable, complete example that
// doesn't depend on the current DB state. Each entry has a small intro
// describing what to look for, a fenced code block (rendered with syntax
// highlighting), and a "what is this" caption.
//
// Keys here must match `StageDef.outputExampleKey` in stages.ts.

export interface Sample {
  intro?: string;
  language: 'json' | 'sql' | 'typescript' | 'markdown' | 'text' | 'http';
  code: string;
  caption?: string;
}

export const SAMPLES: Record<string, Sample> = {
  // ── External sources ─────────────────────────────────────────────────────

  'excel-row': {
    intro: 'One row from the "CDIO internal committee" sheet, after parsing.',
    language: 'json',
    code: `{
  "Project ID": "PRJ0021672",
  "Project Name": "Active Directory Evolution",
  "DDS": "GIO",
  "Gate": "1",
  "Decision": "Passed",
  "Review Date": "2026-04-13",
  "Cost (k€)": 850,
  "Description": "Replace legacy on-prem AD with EntraID + Okta cloud directory; global rollout.",
  "Link (Folder)": "https://drive.google.com/drive/folders/12FRkLWuKb_ETJAaUCGn2_Vd-PmKJuPsP"
}`,
    caption: 'Parsed by xlsx package, mapped into the projects table.',
  },

  'drive-root-listing': {
    intro: 'Sample of one level-1 PRJ folder as returned by Drive API.',
    language: 'json',
    code: `{
  "id": "12FRkLWuKb_ETJAaUCGn2_Vd-PmKJuPsP",
  "name": "PRJ0021672",
  "mimeType": "application/vnd.google-apps.folder"
}`,
    caption: 'Discovery picks the digits after PRJ and matches against projects.project_id.',
  },

  'target-catalog-entry': {
    intro: 'One canonical GIO Service Line as defined in target-catalog.ts.',
    language: 'typescript',
    code: `{
  name: 'Security & Compliance',
  description: "Designs, builds, and operates the solutions that protect the Group's digital estate. " +
               "Portfolio: IAM, End-user Security, Perimeter Security, Vulnerability & Compliance. " +
               "Includes the CSIRT. Led by Jean-Charles Martin.",
  typicalRoles: ['primary_provider', 'risk_owner'],
  typicalImpactTypes: ['security_dependency', 'infrastructure_shared', 'organizational'],
}`,
    caption: 'Used by the LLM prompts as ground-truth taxonomy AND by impact-engine to validate emitted targets.',
  },

  // ── Storage rows ─────────────────────────────────────────────────────────

  'projects-row': {
    intro: 'One row from the projects table after Excel upload + Discovery.',
    language: 'sql',
    code: `project_id      : 'PRJ0021672'
name            : 'Active Directory Evolution'
dds             : 'GIO'
gate            : '1'
decision        : 'Passed'
review_date     : '2026-04-13'
cost_keur       : 850.0
description     : 'Replace legacy on-prem AD with EntraID + Okta…'
link_folder     : 'https://drive.google.com/drive/folders/12FRkLW…'
link_positions  : ''
link_cioo       : ''
batch_id        : '7b1f-…'`,
    caption: 'PK is the auto id; project_id is unique. Discovery upserts link_folder when a matching subfolder is found.',
  },

  'documents-cache-row': {
    intro: 'One row in documents_cache. PK is (project_id, url).',
    language: 'sql',
    code: `id            : 8421
project_id    : 'PRJ0021672'
url           : 'https://drive.google.com/file/d/1jiE3J1bLdGo…/view'
file_name     : '260309 - PRJ0021672 - Post-Active Directory Gate 1 TADA'
content_text  : 'TADA approves the project for Gate 1, under the following conditions: …'
content_type  : 'downloaded'
fetch_status  : 'success'          -- can also be: skipped_deprecated | skipped_cross_prj | skipped_duplicate | error
fetched_at    : '2026-06-15 12:09:33'`,
    caption: "Per-file row (post-Onda 1). The url is the file's own GDrive deep link so the citation popover can open it directly.",
  },

  'hygiene-verdict': {
    intro: 'Three example verdicts from file-hygiene.ts:classifyFile().',
    language: 'typescript',
    code: `classifyFile('PRJ0021760', 'OLD_VERSION - DO NOT USE - Gate 1 Note.txt')
  // → { keep: false, reason: 'deprecated' }
classifyFile('PRJ0021760', 'PRJ0021670_-_Cyber_TI_-_Gate_1.txt')
  // → { keep: false, reason: 'cross_prj' }   (different PRJ id in filename)
classifyFile('PRJ0021672', 'Q&A (Active Directory Evolution - PRJ0021672).txt')
  // → { keep: true }`,
    caption: 'Plus a post-pass dedupe by sha256 of content_text. Result stored as fetch_status="skipped_*" so getProjectDocuments() filters them out.',
  },

  'extracted-text': {
    intro: 'First lines of extracted text from a TADA document.',
    language: 'text',
    code: `TADA approves the project for Gate 1, under the following conditions:
  - Communicate with OT teams (Cyber-OT is out of scope but must align on identity)
  - Define a measurable PoC scope before Gate 2
  - Address sovereignty (China data) as part of the study

Decision: Passed (conditional)
Date: 2026-03-09
Attendees: Mark WILLIAMS, Cyril SURCIN, Jerome ETIENNE-SC, Mehdi GASMI, …`,
    caption: 'Truncated to 30K chars per file. Used both by Goals LLM and downstream search/grep.',
  },

  // ── Goals stage ──────────────────────────────────────────────────────────

  'goals-llm-response': {
    intro: 'Raw JSON returned by Gemini for PRJ0021672 — abbreviated to the load-bearing fields.',
    language: 'json',
    code: `{
  "summary_one_line": "Decommissions legacy on-prem Active Directory globally; replaces with EntraID + Okta cloud identity managed by GIO Security & Compliance.",
  "digital_technologies": "Active Directory, EntraID, Okta, Kerberos, LDAP, GCP/Azure cloud directory services…",
  "regional_impacts": "Global rollout. APAC has explicit China data sovereignty constraints (Q12 risk).",
  "gio_sl_dds_impacts": "Primary GIO Security & Compliance ownership; depends on Cloud Services for directory hosting; touches User Workplace via SSO updates.",
  "dds_entities_touched": ["CDIO Office", "APAC"],
  "gio_services_touched": ["Security & Compliance", "Cloud Services"],
  "tech_tags": ["okta", "azure-ad", "carm", "sso"],
  "vendors": ["okta", "microsoft"],
  "data_classifications": ["pii", "gdpr-scope"],
  "mentioned_projects": ["PRJ0022184", "PRJ0018698", "PRJ0010712"],
  "project_relations": [
    {
      "project_id": "PRJ0022184",
      "kind": "predecessor",
      "relation": "HPA reinforcement secures privileged access to new cloud directory",
      "source_file": "Q&A_(Active_Directory_Evolution_-_PRJ0021672).txt",
      "evidence_quote": "High-privilege accounts are extensively hosted within the directory to secure access…",
      "confidence": "stated"
    }
  ],
  "out_of_scope": [
    {
      "topic": "OT / industrial systems",
      "evidence_quote": "AD for OT is not part of this project as indicated in the Note.",
      "source_file": "Q&A_(Active_Directory_Evolution_-_PRJ0021672).txt"
    }
  ],
  "impact_claims": [
    {
      "target_kind": "gio",
      "target": "Security & Compliance",
      "role": "primary_provider",
      "severity": "high",
      "impact_type": "security_dependency",
      "evidence_file": "Q&A_(Active_Directory_Evolution_-_PRJ0021672).txt",
      "evidence_quote": "High-privilege accounts are extensively hosted within the directory to secure access…",
      "confidence": "stated"
    }
  ],
  "timeline_struct": {
    "gate1_actual": "2026-03-09",
    "gate2_target": "2026-Q3",
    "go_live_target": null,
    "must_complete_before": [],
    "blocked_by": []
  }
}`,
    caption: 'Sanitization layer drops anything with malformed role, missing evidence_quote (<10 chars), or non-canonical target. Then upserts into project_goals.',
  },

  'project-goals-row': {
    intro: 'The same data after sanitization, as it sits in the project_goals table.',
    language: 'sql',
    code: `project_id            : 'PRJ0021672'
project_name          : 'Active Directory Evolution'
status                : 'success'
prompt_version        : 4
summary_one_line      : 'Decommissions legacy on-prem Active Directory…'
digital_technologies  : 'Active Directory, EntraID, Okta, Kerberos…'
gio_services_touched  : '["Security & Compliance","Cloud Services"]'
dds_entities_touched  : '["CDIO Office","APAC"]'
tech_tags             : '["okta","azure-ad","carm","sso"]'
vendors               : '["okta","microsoft"]'
mentioned_projects    : '["PRJ0022184","PRJ0018698","PRJ0010712"]'
project_relations     : '[{"project_id":"PRJ0022184","kind":"predecessor",…}]'
out_of_scope          : '[{"topic":"OT / industrial systems",…}]'
impact_claims         : '[{"target_kind":"gio","target":"Security & Compliance",…}]'
timeline_struct       : '{"gate1_actual":"2026-03-09","gate2_target":"2026-Q3",…}'
analyzed_at           : '2026-06-15 12:11:42'
source_files          : '[…JSON of resolved file paths…]'`,
    caption: 'Arrays are JSON-encoded strings. The 4 new columns (project_relations, out_of_scope, impact_claims, timeline_struct) carry post-Onda 2/3 enrichment.',
  },

  // ── Impact stage ─────────────────────────────────────────────────────────

  'impact-llm-response': {
    intro: 'Excerpt of the JSON array Gemini emits per batch of 22 projects.',
    language: 'json',
    code: `[
  {
    "source": "PRJ0021672",
    "target": "GIO_SERVICES",
    "impact_type": "security_dependency",
    "direction": "depends_on",
    "severity": "high",
    "explanation": "High-privilege accounts are extensively hosted within the directory to secure access to IT/OT environments.",
    "gio_services": ["Security & Compliance"],
    "dds_entities": [],
    "citations": [
      {
        "doc_url": "https://drive.google.com/file/d/1fp9OnPIS4heAzUfv_UHpP1YnzbIhvyRF0F322ki00Vk/view",
        "snippet": "High-privilege accounts are extensively hosted within the directory…"
      }
    ]
  },
  {
    "source": "PRJ0021672",
    "target": "PRJ0022184",
    "impact_type": "security_dependency",
    "direction": "depends_on",
    "severity": "high",
    "explanation": "HPA reinforcement secures privileged access to the new cloud directory built by AD Evolution.",
    "gio_services": [],
    "dds_entities": [],
    "citations": []
  }
]`,
    caption: 'storeImpacts attaches evidence_chain (pointer back to the source claim/relation in project_goals) before persisting. citations[] may be empty when the LLM relies on a Goals impact_claim instead — the API enriches it on read.',
  },

  'projects-impact-row': {
    intro: 'One row in projects_impact. PK (source_project_id, target_project_id, impact_type).',
    language: 'sql',
    code: `id                 : 4575
source_project_id  : 'PGM0001209'
target_project_id  : 'GIO_SERVICES'
impact_type        : 'security_dependency'
direction          : 'requires_coordination'           -- claim role=risk_owner
severity           : 'high'
explanation        : 'GDSD (Hamza MOKHTARI) raised a major reservation regarding the migration of critical infrastructure…'
gio_services       : '["Security & Compliance"]'
dds_entities       : '[]'
citations          : '[]'                                  -- LLM left empty; API synthesizes from chain
evidence_chain     : '[{"goal_id":47109,"claim_idx":0,"source":"claim"}]'
batch_id           : '7b1f-…'
created_at         : '2026-06-15 12:17:08'`,
    caption: 'evidence_chain (Onda 4) is the audit trail: impact row → which Goals claim it came from. When citations=[], the API resolves the claim and shows it in the popover.',
  },

  // ── Deep Dive ────────────────────────────────────────────────────────────

  'deep-dive-row': {
    intro: 'Generated markdown narrative + machine-readable sources for one (project, kind, target) tuple.',
    language: 'sql',
    code: `id            : 21
project_id    : 'PRJ0021672'
kind          : 'gio'
target        : 'Security & Compliance'
response_md   : '## Bottom line\\nThe project fundamentally transforms the core IAM…'
sources_json  : '[{"id":1,"doc_url":"https://drive.google.com/file/d/1fp9On…","file_name":"Q&A…","snippet":"High-privilege accounts are extensively hosted…"}]'
source_sig    : 'sha256:8a2…'    -- hash of source_files + analyzed_at; invalidated on Goals re-run
generated_at  : '2026-06-15 12:23:11'
duration_ms   : 28330
llm_model     : 'gemini-2.0-flash'`,
    caption: 'Cached per (project, kind, target). clearAllImpacts() cascades DELETE here so the cache never lags a fresh Impact run.',
  },

  // ── Universe API ─────────────────────────────────────────────────────────

  'universe-api-response': {
    intro: 'Shape returned by GET /api/impact/project/universe?projectId=PRJ0021672.',
    language: 'json',
    code: `{
  "project": { "projectId": "PRJ0021672", "name": "Active Directory Evolution", "dds": "GIO", "currentGate": "1", "costKEur": 850 },
  "gioNodes": [
    {
      "name": "Security & Compliance",
      "severity": "high",
      "impacts": [
        {
          "impactId": 4575,
          "severity": "high",
          "direction": "depends_on",
          "impactTypes": ["security_dependency"],
          "explanations": ["High-privilege accounts are extensively hosted within the directory…"],
          "citationsByExplanation": [[{ "doc_url": "https://drive.google.com/file/d/1fp9On…/view", "file_name": "Q&A …", "snippet": "High-privilege accounts are extensively hosted…" }]],
          "impactTypeByExplanation": ["security_dependency"],
          "severityByExplanation": ["high"],
          "explanation": "High-privilege accounts are extensively hosted within the directory…"
        }
      ]
    }
  ],
  "ddsNodes": [ /* … */ ],
  "projectEdges": [ /* PRJ↔PRJ edges, e.g. → PRJ0022184 */ ],
  "stats": { "gioCount": 2, "ddsCount": 2, "projectCount": 4, "totalImpacts": 8 }
}`,
    caption: "Parallel arrays (citationsByExplanation / impactTypeByExplanation / severityByExplanation) keep the per-message UI alignment correct. fanOutPseudo() filters each node's impacts to only the rows whose own gio_services included that node.",
  },

  // ── Discovery output ─────────────────────────────────────────────────────

  'discovery-result': {
    intro: 'Return value of discoverAndAddProjectFromDrive() in link-only mode.',
    language: 'json',
    code: `{
  "scannedFolders": 244,
  "linked": [
    { "projectId": "PRJ0021672", "name": "Active Directory Evolution" },
    { "projectId": "PRJ0021760", "name": "CSIRT CTI" }
    /* … 132 more */
  ],
  "created": [],          // empty — Sync All calls with createMissing:false
  "unmatched": [
    { "folderName": "01 Igarape Archive", "extracted": "" }
  ]
}`,
    caption: 'Sync All passes createMissing:false so unmatched folders are noted but no stub project rows are inserted.',
  },
};

export function getSample(key: string | undefined): Sample | undefined {
  if (!key) return undefined;
  return SAMPLES[key];
}
