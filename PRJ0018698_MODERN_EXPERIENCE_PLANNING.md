# PRJ0018698 — Modern Experience — Simple Planning

Source files: `data/drive/PRJ0018698/` (TADA notes 2024-11-12 & 2025-09-29, OCDIO Gate 2 Position 2026-01, Q&A doc). Test artifact for the planning feature — not an official project plan.

## 1. Summary

- **Project**: Modern Experience (End User Workplace) — PPM code PRJ0018698
- **Business line**: GIO (User Workplace) | **Zone**: Global/WW
- **BPM**: Jerome Bachelerie
- **Goal**: Replace the dual Marimba (PC) + Workspace ONE (mobile) model with a single cloud-native Workspace ONE (Omnissa) solution for all devices — zero-touch provisioning, self-enrollment/self-healing via "Yourway" portal, decommission legacy Marimba.
- **Vendor commitment**: 5-year Omnissa contract, ~€9.4M (consolidation of existing run costs + renewals, not new money).

## 2. Timeline — Dates & Events

| Date | Event |
|---|---|
| 2024-11-12 | **TADA Gate 2** (1st pass) — architecture committee review. **Not validated**, rescheduled. |
| 2025-09-29 | **TADA Gate 2** (2nd pass) — **Contingently approved**, pending DRMT validation before OCDIO presentation. |
| 2025-09-30 | DRMT still not validated at this point (per committee note). |
| 2026-01 | **OCDIO Position — Gate 2 (Capital Commitment)**. Decision: **Approved**, with 3 conditions (see §4). |
| 2026-01-30 | **Hard deadline** — Purchase Order must reach Omnissa (via ComputaCenter). |
| 2026 Q1–Q2 (Mar/Apr) | Deployment start for new PCs on the new platform. |
| 2026 (full year) | Dual-run period: Marimba stays fully usable in parallel (infra-cost only, no license cost). |
| 2027 | Target to update GIO Service Catalogue pricing/recharge model. |
| TBD | Pentest of the full service, executed before Go-Live. |
| TBD | **Gate 3** — review of mitigations, before Go-Live. |
| Mid-2028 | Target for complete migration + decommissioning of Marimba. |
| From 2029 | Run-cost savings realized (~€2,425k/year). |

## 3. Gates

| Gate | Status | Notes |
|---|---|---|
| TADA Gate 2 (Nov 2024) | ❌ Rejected / rescheduled | Concerns: EntraID/Azure dependency, legacy auth (Kerberos/LDAP/NTLM), DRMT scope |
| TADA Gate 2 (Sep 2025) | ✅ Contingent approval | Condition: DRMT validated before Gate 2 OCDIO presentation |
| OCDIO Gate 2 — Capital Commitment (Jan 2026) | ✅ Approved (conditional) | See open conditions below |
| Gate 3 | ⏳ Not yet scheduled | Review of mitigations prior to Go-Live |

## 4. Open Actions / Gate-2 Conditions

1. **Cybersecurity / DRMT** — update the Entra ID DRMT to formally cover the new scope (PC directory migration), validated by GDSD before full deployment.
2. **Compliance** — Legal/Data Privacy (IPC) validation of cross-border data access from India under the GDDS support model.
3. **Pentest** — execute before Go-Live (whole service).
4. **Legacy app remediation** — DDS and Application Owners must be formally notified they fund remediation of incompatible legacy apps (found during the ~400-package validation); escalate to OCDIO if volume/cost is significant.
5. **Service Catalogue** — clarify impact on GIO service catalogue definitions/pricing/recharge (target 2027).
6. **Migration tooling** — validate the internal "No Wipe" engineering tool; Quest is the budgeted commercial fallback if it fails validation.
7. **Governance housekeeping** — confirm whether ALIT Administration Committee sign-off is required (contract is under the €10M threshold, believed not required, final confirmation pending); GIO PM training on ServiceNow status updates to be scheduled.

## 5. CAPEX / OPEX

**Estimated project cost (Gate 2, approved): 2,084 k€**

| Item | CAPEX | OPEX | Total |
|---|---|---|---|
| Gate 2 approved budget | 854 k€ | 1,228 k€ | 2,084 k€ |

- **Funding entity**: ALIT dept GIO — Funding responsible: Maria Tkach-Fara / Marie Leroux
- OPEX is disproportionately high vs. CAPEX because of:
  - **503 k€** disposable Quest migration licenses (one-time, discarded after transition)
  - Internal labor rules: staff spending <50% time on the project, or unbackfilled positions, are logged as OPEX rather than capitalized
- **Separate vendor commitment** (not part of the 2,084 k€ project budget): ~**€9.4M** over 5 years with Omnissa — this is a consolidation of pre-existing Marimba + Workspace ONE run-rate and renewals, not incremental spend.

**Projected savings**
- Running costs to **decrease by ~2,425 k€/year from 2029**, including a €2,520k reduction in IT support needs/workload.
- ~€1M of Service Desk ticket-reduction savings, confirmed **incremental** (distinct from the parallel Service Desk Transformation project's savings).
