import { extractProjectIds } from './project-id';

// Canonical catalogs the Goals Extractor normalises against.
// All values are lowercase, hyphen-separated. The Impact engine treats them as
// opaque identifiers — overlap between two projects on the same canonical tag
// is a direct signal of shared stack / vendor / data class.

export const TECH_CATALOG: ReadonlyArray<string> = [
  // Cloud platforms
  'aws', 'azure', 'gcp', 'oracle-cloud', 'alibaba-cloud', 'ovh',
  // ERP / business suites
  'sap-s4', 'sap-ecc', 'sap-bw', 'sap-hana', 'oracle-ebs', 'workday', 'servicenow', 'salesforce',
  // Data platforms
  'snowflake', 'databricks', 'bigquery', 'redshift', 'synapse', 'palantir',
  // Databases
  'oracle-db', 'postgres', 'mysql', 'mssql', 'mongodb', 'cassandra', 'elasticsearch',
  // Streaming / messaging
  'kafka', 'rabbitmq', 'sqs', 'eventhub',
  // BI / analytics
  'powerbi', 'tableau', 'qlik', 'looker', 'sap-analytics-cloud',
  // Identity / access
  'okta', 'azure-ad', 'ping-identity', 'sso', 'carm',
  // Collaboration
  'm365', 'teams', 'slack', 'sharepoint', 'onedrive',
  // Dev tooling
  'github', 'gitlab', 'bitbucket', 'jenkins', 'jira', 'confluence', 'azure-devops',
  // Containers / orchestration
  'kubernetes', 'docker', 'openshift', 'ecs', 'aks', 'gke',
  // AI / ML
  'openai', 'anthropic', 'gemini', 'vertex-ai', 'sagemaker', 'azure-openai',
  'langchain', 'huggingface', 'genai',
  // Automation / RPA
  'uipath', 'blueprism', 'automation-anywhere', 'power-automate',
  // CRM / customer
  'sap-c4c', 'sap-customer-experience', 'dynamics-365',
  // Integration
  'mulesoft', 'boomi', 'sap-pi-po', 'sap-cpi', 'apim',
  // Networking / security
  'cisco', 'fortinet', 'palo-alto', 'zscaler', 'crowdstrike', 'sentinelone',
  // Monitoring / observability
  'datadog', 'splunk', 'dynatrace', 'new-relic', 'grafana', 'elk',
  // Frontend
  'react', 'angular', 'vue', 'nextjs',
  // IoT / edge
  'iot', 'edge-computing', 'azure-iot',
  // Industrial / Air-Liquide-specific
  'osisoft-pi', 'aveva', 'siemens-tia', 'rockwell',
];

export const VENDOR_CATALOG: ReadonlyArray<string> = [
  // Hyperscalers / platform vendors
  'microsoft', 'aws', 'google', 'sap', 'oracle', 'ibm', 'salesforce', 'servicenow',
  'snowflake', 'databricks', 'workday', 'mongodb', 'elastic',
  // Service integrators
  'accenture', 'capgemini', 'deloitte', 'tcs', 'infosys', 'wipro', 'atos', 'sopra-steria',
  'pwc', 'kpmg', 'cgi', 'hcl',
  // Specialist vendors
  'palantir', 'mulesoft', 'okta', 'crowdstrike', 'cisco', 'fortinet',
  // Industrial / specialty
  'aveva', 'osisoft', 'siemens', 'rockwell', 'schneider-electric',
];

// Data sensitivity / regulatory scope. The Impact engine uses overlaps here to
// flag security_dependency edges between projects handling the same data class.
export const DATA_CLASSIFICATION_CATALOG: ReadonlyArray<string> = [
  // PII variants
  'pii', 'customer-pii', 'employee-pii', 'hr-sensitive',
  // Health / payment
  'phi', 'pci-dss',
  // Financial
  'financial-data', 'erp-finance',
  // Regulatory scope
  'gdpr-scope', 'sox-scope', 'nis2-scope', 'iso-27001-scope',
  // Business confidential
  'trade-secrets', 'ip', 'contracts', 'pricing', 'm-and-a',
  // Operational / industrial
  'operational-ot-data', 'safety-critical',
];

// ─── Normalisation helpers ──────────────────────────────────────────────────

const TECH_SET = new Set(TECH_CATALOG);
const VENDOR_SET = new Set(VENDOR_CATALOG);
const DATA_SET = new Set(DATA_CLASSIFICATION_CATALOG);

// Given a free-form string array from the LLM, keep only the items that match
// the canonical catalog. Case-insensitive, trims whitespace. Drops unknowns.
export function filterToCatalog(raw: unknown, catalog: 'tech' | 'vendor' | 'data'): string[] {
  if (!Array.isArray(raw)) return [];
  const set = catalog === 'tech' ? TECH_SET : catalog === 'vendor' ? VENDOR_SET : DATA_SET;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (!norm) continue;
    if (set.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// ─── Canonical DDS entities / GIO services (mirror of impact prompt) ────────
// Keep aligned with the lists baked into prompts.ts > DEFAULT_IMPACT_PROMPT.

export const DDS_ENTITIES: ReadonlyArray<string> = [
  // Geographic zones
  'Americas', 'Europe', 'APAC', 'AMEI',
  // Business divisions / SBUs
  'CF', 'GM&T', 'E&C', 'HC D&IT', 'Alizent', 'GDO', 'SEPPIC', 'Airgas', 'HHC',
  // App / functional groups
  'Industrial Apps', 'Enterprise Apps', 'Data & AI Apps', 'Digital Factory',
  'InnoTech', 'CDIO Office', 'IDD',
];

export const GIO_SERVICES: ReadonlyArray<string> = [
  'Security & Compliance',
  'Command Center',
  'User Workplace',
  'Site Infrastructure',
  'Cloud Services',
];

const DDS_SET = new Set(DDS_ENTITIES);
const GIO_SET = new Set(GIO_SERVICES);

export function filterToDdsEntities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (DDS_SET.has(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function filterToGioServices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (GIO_SET.has(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Project ids mentioned inside extracted document text.
 *
 * Delegates to the shared canonicaliser in `project-id.ts`. The previous
 * inline regex accepted any digit count and upper-cased whatever followed, so
 * the template placeholder `PRJ00XXXX` was recorded as a real project three
 * times in the live database, and `PRJ17301` never matched the `PRJ0017301`
 * that the CDIO sheet actually holds.
 */
export function extractMentionedProjects(text: string, excludeProjectId: string): string[] {
  return extractProjectIds(text, excludeProjectId);
}
