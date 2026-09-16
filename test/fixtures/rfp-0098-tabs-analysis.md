---
rfp: RFP-0098
kind: rfp
client: Tabs GmbH
source:
  - {file: rfp-0098-tabs.xlsx, size: 900, sha256: 1111111111111111111111111111111111111111111111111111111111111111}
shopware: 6.7.13.0 Community (composer.lock shopware/core v6.7.13.0); PHP 8.5 (compose.yaml)
status: Draft
batch: 50
confidence: 60
updated: 2026-09-07
counts:
  rows: 4
  assumptions: {proposed: 1, accepted: 0, rejected: 0, suspect: 0}
  questions: {client: 1, blocking: 0, partner: 0, high: 0}
  clarifications: 0
export: {date: null, files: [], source_sha256: null, stale: false}
---

# RFP-0098 — Tabs GmbH — Tab layout fixture

## 1. Context

### 1.1 Meta

| Field | Value | Source |
| --- | --- | --- |
| RFP reference | TABS-2026-01 | 1 Cover · RFP reference |
| Kind | rfp | 1 Cover |
| Issuing company | Tabs GmbH | 1 Cover · Issuing company |
| Contact | Ada Lindqvist, Head of E-Commerce | 1 Cover · Contact |
| Questions until | 2026-09-25 | 1 Cover · Questions until |
| Proposal due | 2026-10-16, 12:00 CET | 1 Cover · Proposal due |
| Contract award | _not provided_ | — |
| Go-live | 2027-06-30 (fixed) | 1 Cover · Kickoff / go-live |
| Response instructions | Fill the Vendor: columns of sheets 2 and 3 | 5 Vendor Response · Response instructions |
| Compliance tokens | Stock, Config, Plugin, Custom, Not offered | 5 Vendor Response · Response instructions |
| Effort unit | PD | 5 Vendor Response · Response instructions |
| Out of scope per RFP | PIM introduction; a mobile app | 2 Company & Context · Constraints |
| Budget as stated | none stated | — |

### 1.2 Company & context

**Profile.** Distributor of industrial supplies, 210 employees, DE and AT.

**Current landscape.** Shopware 5.7 on PHP 7.4; Business Central is the leading system.

**Pain points and goals.** Stock and prices are a day old; the B2B plugin is unmaintained.

**Constraints.** Business Central stays the leading system; big-bang cutover.

**Key parameters.**

| # | Parameter | Value | Source | Drives | Status |
| --- | --- | --- | --- | --- | --- |
| P-01 | Sellable SKUs / variants | 25,000 | 2 Company & Context · Volumes/Products | import, indexing, migration, search | stated |
| P-03 | Categories | 1,100 | 2 Company & Context · Volumes/Products | navigation, migration, SEO | stated |
| P-12 | Customer-specific price rows | _not provided_ | — | price sync volume, performance | _not provided_ ⚠ CQ-1 |
| P-24 | Average order value | _not provided_ | — | context only, never priced | _not provided_ |

**Migration inventory.**

| # | Object | Source | Volume | Must migrate | Approach | Rows | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M-1 | Products and variants | SW5 database + ERP | 25,000 SKUs / 6,000 parents | Yes | _TBD_ | MIG-01 | Master data from ERP |
| M-2 | Product images | SW5 media | 40,000 files, ~38 GB | Yes | _TBD_ | MIG-01 | Alt texts kept |

### 1.3 Source map

| # | Table (sheet / section) | Rows | Id column | Vendor columns (client's words) | Tokens | Effort unit | Locator |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Cover | 12 | — | context → §1.1 | — | — | `01-cover.csv` rows 1–12 |
| 2 | Company & Context | 20 | — | context → §1.2 | — | — | `02-company-context.csv` rows 1–20 |
| 3 | Requirements | 2 | ID | Vendor: Compliance, Vendor: Comment, Vendor: Effort (PD) | Stock, Config, Plugin, Custom, Not offered | PD | `03-requirements.csv` rows 2–3 (`GEN-01`…`STF-01`) |
| 4 | Non-functional & Compliance | 1 | ID | Vendor: Compliance, Vendor: Comment, Vendor: Effort (PD) | Stock, Config, Plugin, Custom, Not offered | PD | `04-non-functional-compliance.csv` rows 2–2 (`NFR-01`…`NFR-01`) |
| 5 | Vendor Response & Evaluation | 1 | ID | Vendor: Compliance, Vendor: Comment, Vendor: Effort (PD) | Stock, Config, Plugin, Custom, Not offered | PD | `05-vendor-response.csv` rows 4–4 (`PRJ-01`…`PRJ-01`) |
| 6 | Integrations | 2 | — | context → §8 | — | — | `06-integrations.csv` rows 1–2 |
| 7 | Glossary | 2 | — | context → §9 | — | — | `07-glossary.csv` rows 1–2 |

Minted IDs: none · Prefilled vendor cells: none · Ignored: none · Warnings: none

### 1.4 Ground truth

Shopware 6.7.13.0 Community (composer.lock) · Project plugins none · Partner assets none · Prior analyses reused none · KB pages platform/index.md · Agents PM C1; architect C1; QA no

## 2. Summary

| Scope | PD |
| --- | --- |
| Must (fixed-price scope) | 12 |
| Should | 0 |
| Could | 0 |
| of which Services | 0 |
| **Total** | 12 |

By area: STF: 10 · GEN: 0 · NFR: 2 · Foundation efforts: none · Overhead / buffer: 10% folded · buffer 5% separate · level buffers 0/10/25% · Plan variants: single variant · Blocking rows: none

| Dimension | Weight | Score | Points |
| --- | --- | --- | --- |
| Coverage evidence | 20 | 70 | 14.0 |
| Estimate basis | 20 | 60 | 12.0 |
| Scope lock | 20 | 40 | 8.0 |
| Platform decision | 15 | 70 | 10.5 |
| Integration & migration | 15 | 40 | 6.0 |
| Consistency | 10 | 70 | 7.0 |
| **Total** | **100** | | **60%** |

Weakest dimension: Integration & migration — P-12 not provided (CQ-1)

## 3. Global assumptions

Lines no single row owns. Same status grammar as §4.

| ID | Kind | Rows | Statement | PD saved | Risk to | Status |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | assume | STF-01 | The theme extends the default Storefront theme | STF-01 −2 | client | [ ] |

## 4. Requirement analysis

| ID | Kind | Prio | Class | L/M/H | Lvl | PD | Text | Evidence / risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GEN-01 | req | Must | stock | 0/0/0 | detailed | 0 | Shopware 6.7 as the target platform | pm: confirmed-stock (composer.lock) | estimated |
| STF-01 | req | Must | custom | 8/10/14 | medium | 10 | Theme plugin extending @Storefront; the PDP shows the packaging unit and the SKU per variant | arch: ThemeInterface | estimated |
| NFR-01 | req | Must | config | 1/2/3 | medium | 2 | Core Web Vitals budgets enforced in CI | arch: Lighthouse CI | estimated |
| PRJ-01 | req | Must | commitment | 0/0/0 | detailed | 0 | Weekly status report and a named project lead | pm: n/a — contract row | estimated |

Kinds: `req` one per source row · `assume` `<ROW>.a<n>` · `clarify` `<ROW>.c<n>`.

## 5. Open questions

### CQ-1 · P-12 · blocking: no
How many customer-specific article prices are maintained today?
- [ ] A — fewer than 10,000 rows
- [ ] B — 10,000 to 200,000 rows
- [ ] Other:
Until answered we assume option B.

Not sent — cap: none

## 6. Approach

| Item | Decision | Reason (rows served, source) | Alternative · PD delta |
| --- | --- | --- | --- |
| Plan | Community | no B2B row in scope (GEN-01) | Rise: +0 PD |
| Hosting | _TBD_ | | |
| PSP | _TBD_ | | |
| CMP | _TBD_ | | |

| Interface | Pattern | Owner split | Risk |
| --- | --- | --- | --- |
| §8 I-1 | queue consumers, idempotent upserts | bidder: shop side; ERP partner: API pages | field mapping late |

| Migration object | Approach | Volume | Tool | Reuse |
| --- | --- | --- | --- | --- |
| §1.2 M-1 | Import/Export profile | see §1.2 | migration assistant | none |

## 7. Log

Append-only. Never a transcript.

| ID | Date | Topic | Decision |
| --- | --- | --- | --- |
| C-1 | 2026-09-07 | extracted | §1.1, §1.2, §8 and §9 written at the skeleton stage |

## 8. Integrations

| # | System | Direction | Objects | Frequency | Protocol | Counterpart owner | Rows | Class | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-1 | Microsoft Dynamics 365 Business Central | ERP → Shop | Products, prices, stock | Nightly full, 15-min delta | OData v4 REST | Client's ERP partner | GEN-01 | custom | field mapping late |
| I-2 | Consent management platform | Shop ↔ CMP | Consent state | Client side | CMP script | Bidder recommends | NFR-01 | plugin | — |

## 9. Glossary

| Term | Meaning | Maps to |
| --- | --- | --- |
| SKU | Stock keeping unit; a sellable product variant with its own article number. | product variant / `ProductEntity` · GEN-01 |
| PU / Packaging unit | The unit in which a product is sold and priced, e.g. box of 100 pcs. | purchase unit / `purchaseUnit`, `referenceUnit` · STF-01 |
