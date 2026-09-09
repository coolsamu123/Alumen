# Plan — Details view: replace redundant expand with a Project Planning panel

## 1. Goal

Today, `DetailView.tsx` ("Details" menu) renders a grid of project cards. Clicking a card expands it inline to show "AI Extracted Insights" (8 fields) + remarks + review history. All of that already exists, in fuller form, in the **Goals Extractor** tab and the **Impact** tab — the expansion is pure duplication.

Replace the expand-on-click content with a **Project Planning panel**: a well-formatted view of **Timeline (dates & events)**, **Gates**, **Actions**, and **CAPEX/OPEX**, structured the same way as `PRJ0018698_MODERN_EXPERIENCE_PLANNING.md`. The card grid itself (collapsed state) does not change.

## 2. Current redundancy — where it lives

`DetailView.tsx:127-246` — the `isSelected` block — renders, per project:
- `remarks`
- `lastReviewDate` / `costKEur` mini-tiles
- "AI Extracted Insights": `digitalTechnologies`, `businessAppsCis`, `gioSlDdsImpacts`, `ddsGioWorkload`, `changeManagement`, `regionalImpacts`, `securityImpacts`, `iaEmbedded`
- `history` (gate/decision/date table)

Every one of the 8 "AI Extracted Insights" fields is the exact same `project_goals` column already rendered, field-for-field, in `GoalsView.tsx` (`FIELD_LABELS`/`Section` blocks around line 122 and 452-544) — same labels, same source. `history` overlaps with what Gates will show below, so it's absorbed into the new panel rather than kept twice.

**Card collapsed state stays untouched**: header badges (`Gate N`, DDS pill), name, description, decision badge, cost, tags, folder/positions links. Only the `isSelected` block's *content* changes — from inline expand to opening the new panel.

## 3. What the new panel shows

Same four sections as the PRJ0018698 test doc:

1. **Timeline** — chronological list of dated events (TADA sessions, OCDIO positions, deployment milestones, decommission targets, savings realization dates).
2. **Gates** — one row per gate pass (TADA / OCDIO / whatever the docs show), each with a status (approved / rejected / contingent / pending) and a short note.
3. **Actions** — open conditions / follow-ups from the latest gate decision (e.g. "update DRMT", "execute pentest before Go-Live"), each with owner if stated.
4. **CAPEX/OPEX** — approved amounts, currency, funding entity, plus any notable cost drivers or projected savings, when the documents state them. Falls back to the CDIO sheet's single `costKEur` when no breakdown exists in the docs.

## 4. Data: what we already have vs. what needs new extraction

| Data | Source today | Reliable enough to reuse as-is? |
|---|---|---|
| Gate review dates, decisions | `projects` table, one row per review → `ProjectSummary.history` | **Yes** — deterministic, already correct. Use directly, don't re-derive via LLM. |
| `gate1_actual` / `gate2_target` / `go_live_target` | `project_goals.timeline_struct` (Goals Extractor, Onda 3) | Partial — narrow schema (3 dates + blocking edges), no event descriptions, no actions, no CAPEX/OPEX. Use as a *hint*, not the whole Timeline. |
| Total cost | `projects.cost_keur` (CDIO sheet, CAPEX+OPEX pre-combined by `excel-parser.ts:261-270`) | Yes, as a fallback total — the breakdown is lost at ingestion. |
| Timeline events, gate conditions/notes, open actions, CAPEX/OPEX breakdown, cost drivers, savings | Nowhere structured — only free text inside the project's Drive documents (TADA notes, OCDIO Position docs, Q&A) | **No** — needs LLM extraction, same as we did by hand reading `data/drive/PRJ0018698/*.txt`. |

Conclusion: gate *dates/decisions* are built deterministically from `history` (no hallucination risk); everything else (events, per-gate conditions/notes, actions, CAPEX/OPEX) comes from a new LLM extraction over the project's documents, merged with that deterministic gate list in the UI layer.

## 5. New engine: `src/lib/project-planning-engine.ts`

Modeled on `deep-dive-engine.ts`'s cache/invalidate pattern, but **not** grafted onto `impact_deep_dives` / `DeepDiveKind` — that table's shape (`target`, edge-narrative few-shot, `[n]` citation markers baked into prose) is built for GIO/DDS/project-to-project impact narratives. Planning has no "target" edge and needs precise structured fields (dates, amounts) the UI can lay out exactly — a dedicated JSON schema is a better fit than shoehorning it into that prose pipeline.

**Inputs**: `getProjectDocuments(projectId)` (drive-engine.ts, same source deep-dive/goals use), the project's `history` rows, `project_goals.timeline_struct` if present.

**Cache key** (`source_sig`): same recipe as `deep-dive-engine.ts:102-106` — hash of `project_goals.source_files + analyzed_at`. Regenerates automatically when documents are re-scanned; no manual flush needed.

**Prompt** (`json: true` via `generateContent`, temperature ~0.2): ask for exactly this shape, `null`/`[]` when not stated — never inferred, same discipline as `timeline_struct`'s existing rule (`prompts.ts:120-135`):

```json
{
  "events": [
    { "date": "YYYY-MM-DD or YYYY-MM or null", "label": "short event description", "evidence_file": "filename" }
  ],
  "gates": [
    { "gate": "2", "date": "YYYY-MM-DD", "forum": "TADA | OCDIO | ...", "decision": "approved | rejected | contingent | pending", "note": "one line", "evidence_file": "filename" }
  ],
  "actions": [
    { "title": "short imperative", "owner": "team or person, or null", "status": "open | done", "evidence_file": "filename" }
  ],
  "financials": {
    "capex_keur": 854,
    "opex_keur": 1228,
    "total_keur": 2084,
    "currency": "EUR",
    "funding_entity": "ALIT dept GIO",
    "notes": "one or two lines on cost drivers / savings, or null"
  }
}
```

Deterministic `history` rows are merged into `gates` client- or server-side (dedup by gate number, prefer the deterministic date/decision over the LLM's if both exist for the same gate) — the LLM only *adds* the qualitative note/forum/conditions that aren't in the sheet.

**New table** (`db.ts`, same migration style as the rest of the file):

```sql
CREATE TABLE IF NOT EXISTS project_planning (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  response_json   TEXT NOT NULL,     -- the schema above, stringified
  llm_provider    TEXT NOT NULL,
  llm_model       TEXT NOT NULL,
  generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  source_sig      TEXT NOT NULL,
  duration_ms     INTEGER,
  output_language TEXT NOT NULL DEFAULT 'en',
  UNIQUE(project_id, output_language)
);
CREATE INDEX IF NOT EXISTS idx_project_planning_project ON project_planning(project_id);
```

Exported functions, mirroring `deep-dive-engine.ts`'s public shape:
- `getOrGeneratePlanning({ projectId, force }: { projectId: string; force?: boolean }): Promise<PlanningResult>`
- `getCachedPlanning(projectId): PlanningResult | null` (no LLM call — for a GET/list endpoint)

## 6. New API route: `src/app/api/impact/project/planning/route.ts`

Same contract shape as `deep-dive/route.ts`:
- `POST { projectId, force? }` → get-or-generate, returns `PlanningResult`.
- `GET ?projectId=` → cached-only, `null` if never generated (so the UI can decide whether to show a "Generate" button or auto-trigger POST on first open).

## 7. UI changes

**`DetailView.tsx`**: delete the "AI Extracted Insights" + remarks + history block (lines ~127-246). Keep `onClick={() => setSelected(...)}` and the `isSelected` ring/border styling on the card. Replace the deleted block with:

```tsx
{isSelected && <ProjectPlanningPanel projectId={p.projectId} onClose={() => setSelected(null)} />}
```

Rendered as a centered modal overlay (`fixed inset-0 z-50`, dismiss on backdrop click or Escape) rather than inline-in-card — the content is too tall for a card and the grid would reflow awkwardly. `Sidebar.tsx`'s "Selected Project / Services" panel is unaffected (it reacts to the same `selected` id independently).

**New `src/components/ProjectPlanningPanel.tsx`**:
- On mount: `GET` cached planning. If none, show a "Generate plan" call-to-action (LLM calls are not free — don't auto-fire on every card click) with an estimated-time note; on click, `POST`. If cached, render immediately with a small "Regenerate" affordance + `generated_at` timestamp, matching the `DeepDiveButton` loading/elapsed-timer UX in `EvidencePanel.tsx:309-465`.
- Sections, each visually distinct (not a markdown blob):
  - Header: project id/name, current gate badge (`getGateColor`), decision badge (`getDecisionColor`).
  - **Timeline**: vertical list, sorted by date, `null`-dated events grouped at the bottom under "Undated".
  - **Gates**: one card per gate, colored by `getGateColor`/`getDecisionColor`, merged deterministic + LLM note as described in §5.
  - **Actions**: checklist styling, owner as a small tag.
  - **CAPEX/OPEX**: two stat tiles (CAPEX / OPEX) + total; if `financials` is empty, fall back to `p.costKEur` labeled "Total cost (CDIO sheet, no breakdown available)".
- Empty-Drive-docs case (source='excel' with no PRJ folder, or 'initiative'/'drive' with zero fetched docs): skip the "Generate" flow, show the deterministic Gates/cost only with a note that no supporting documents were found.

## 8. Rollout / test plan

1. Migrate DB (new table), implement engine + route with no UI changes yet — verify via `curl`/Postman against `PRJ0018698` and diff the output against `PRJ0018698_MODERN_EXPERIENCE_PLANNING.md` (already hand-validated from the same source documents — good golden case).
2. Build `ProjectPlanningPanel`, wire into `DetailView`, remove the old expand block.
3. Manual pass in the browser: `PRJ0018698` (rich docs, real CAPEX/OPEX), a project with only a CDIO sheet row and no Drive folder (fallback path), a project with multiple historical gate reviews (merge logic).
4. Confirm Goals Extractor and Impact tabs are unaffected (no shared component was touched besides the new imports).

## 9. Open questions

- Auto-generate on first click vs. explicit "Generate" button — leaning explicit, to keep LLM spend visible and predictable (same reasoning as `DeepDiveButton`'s idle→loading gate).
- Multi-language: reuse `output_language` exactly like `impact_deep_dives`/`project_goals`, so the panel respects the app's active output language setting.
