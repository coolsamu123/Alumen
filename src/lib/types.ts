// ─── CIOO Project Data Model ─────────────────────────────────────────────────

export interface CIOOService {
  id: string;
  name: string;
  owner: string;
  domain: string;
}

export interface CIOOProject {
  id: number;
  projectId: string;        // ServiceNow # (PRJ0004517)
  name: string;
  dds: string;              // Division (AMEI, APAC, CF, etc.)
  gate: string;             // 0, 1, 1 MVP, 2, 3, 4, etc.
  costKEur: number | null;
  description: string;
  remarks: string;
  qa: string;
  reviewDate: string;       // ISO date
  decision: string;         // Passed, Not Passed, On Hold, Delegated
  decisionMode: string;     // Meeting / Off-line
  decisionDate: string;
  reviewStatus: string;
  documentsStatus: string;
  restricted: string;
  costBeforeG2: number | null;
  estGate2Date: string;
  sessionStart: string;
  sessionEnd: string;
  participants: string;
  linkPositions: string;
  linkFolder: string;
  linkCIOO: string;
  year: number | null;
  month: number | null;
  batchId: string;
  services?: CIOOService[];
}

// Deduplicated project (latest gate review per ServiceNow #)
export interface ProjectSummary {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  latestDecision: string;
  costKEur: number | null;
  description: string;
  remarks: string;
  reviewCount: number;
  lastReviewDate: string;
  linkPositions: string;
  linkFolder: string;
  linkCIOO: string;
  // Computed
  tags: string[];
  history: CIOOProject[];

  // New Sub-App fields
  digitalTechnologies?: string;
  changeManagement?: string;
  securityImpacts?: string;
  regionalImpacts?: string;
  iaEmbedded?: string;
  gioSlDdsImpacts?: string;
  ddsGioWorkload?: string;
  businessAppsCis?: string;
  
  // project_goals fields
  region?: string;
  monthFolder?: string;
  rawGeminiResponse?: string;
  sourceFiles?: string;
  analyzedAt?: string;
  goalStatus?: string;
  errorMessage?: string;

  subappAnalyzed?: boolean;
  services?: CIOOService[];
}

// Similarity link between two projects
export interface SimilarityLink {
  source: string;
  target: string;
  strength: number;
  aiAnalyzed: boolean;
}

// Gemini analysis result
export interface AnalysisResult {
  id: number;
  analysisType: 'pairwise' | 'cluster' | 'document';
  projectIds: string[];
  themes: string[];
  synergies: string[];
  risks: string[];
  recommendations: string[];
  similarityScore: number;
  createdAt: string;
  modelUsed: string;
}

// Filter state
export interface FilterState {
  dds: string;
  gate: string;
  decision: string;
  yearFrom: number | null;
  yearTo: number | null;
  search: string;
  // Impact-only: 'All' | 'high' | 'low'. Other views ignore it.
  severity: string;
}

// View type
export type ViewType = 'graph' | 'matrix' | 'timeline' | 'detail' | 'impact' | 'goals' | 'drive' | 'strom' | 'universe';

// ─── Impact Analysis ──────────────────────────────────────────────────────────

// One citation backing a single impact explanation. doc_url is the original
// Google Drive URL (already what we use as the cache key); file_name is the
// human-readable name fetched from Drive metadata at download time; snippet is
// the first sentence of the source paragraph the LLM grounded the claim on.
export interface ImpactCitation {
  doc_url: string;
  file_name: string;
  snippet: string;
}

// One entry in projects_impact.evidence_chain — points back to the Goals
// extractor row + the specific claim or relation that generated this impact.
export interface EvidenceChainEntry {
  goal_id: number;
  claim_idx?: number;
  relation_idx?: number;
  source: 'claim' | 'relation' | 'free';
}

export interface ProjectImpact {
  id: number;
  sourceProjectId: string;
  targetProjectId: string;
  impactType: string;
  direction: string;
  severity: string;
  explanation: string;
  batchId: string;
  createdAt: string;
  // GIO specific flags parsed from JSON (JSON array stored in DB)
  gioServices?: string[];
  // DDS entities affected when target='DDS_IMPACTS' (JSON array stored in DB)
  ddsEntities?: string[];
  // Citations backing this row's explanation. Empty for legacy rows generated
  // before the citation pipeline existed; UI must treat absence as "no source".
  citations?: ImpactCitation[];
  // Onda 4: trace from this impact row → which Goals claim/relation generated
  // it. Empty for legacy rows. When `citations` is empty, the UI can fall
  // back to fetching the underlying claim's evidence_quote + evidence_file via
  // this chain. Shape: [{goal_id, claim_idx?|relation_idx?, source}]
  evidenceChain?: EvidenceChainEntry[];
  // ─── Aggregation extras ───
  // When the API returns aggregated rows (default), one row represents all raw
  // edges between the same pair of projects (regardless of direction). The
  // singular fields above carry the "primary" (highest-severity) row's values;
  // the fields below describe the full set merged into this entry.
  impactTypes?: string[];   // union of all impact_type values for this pair
  directions?: string[];    // union of all directions seen
  explanations?: string[];  // every raw explanation (primary first)
  // Parallel to `explanations`: citationsByExplanation[i] backs explanations[i].
  citationsByExplanation?: ImpactCitation[][];
  // Parallel to `explanations`: the raw row's `impact_type` / `severity` that
  // produced each explanation. Lets the UI annotate each "Reason for the
  // impact" bullet with the specific badges instead of only showing the union
  // at the card level.
  impactTypeByExplanation?: string[];
  severityByExplanation?: string[];
  // Parallel to `explanations`: which GIO services / DDS entities the
  // originating raw row pointed at. Lets the universe API filter messages
  // per pseudo-node so clicking "Cloud Services" only shows explanations
  // whose row touched Cloud Services (not the union of all GIO services).
  gioServicesByExplanation?: string[][];
  ddsEntitiesByExplanation?: string[][];
  count?: number;           // number of raw rows merged
  bidirectional?: boolean;  // true if both A→B and B→A had raw rows
}

export interface ImpactAnalysisStatus {
  isRunning: boolean;
  totalProjects: number;
  totalBatches: number;
  completedBatches: number;
  totalImpacts: number;
  currentBatchDDS: string;
  errors: string[];
  /** Non-fatal notices from the run (e.g. a project whose content was trimmed
   *  to fit the prompt budget). Separate from `errors` so the error count the
   *  UI shows keeps meaning "something actually failed". */
  warnings: string[];
  /** Last entry in the `impact_runs` journal, so a run that died mid-flight
   *  (OOM, restart) stays visible after the in-memory state is gone.
   *  `status: 'aborted'` means exactly that. Null when no run was ever
   *  journalled. */
  lastRun?: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    completedBatches: number;
    totalBatches: number;
    totalImpacts: number;
  } | null;
}
