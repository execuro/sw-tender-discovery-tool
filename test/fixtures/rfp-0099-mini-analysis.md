---
rfp: RFP-0099
kind: rfp
client: Mini GmbH
source:
  - {file: rfp-0099-mini.csv, size: 412, sha256: 0000000000000000000000000000000000000000000000000000000000000000}
shopware: 6.7.13.0 Community (composer.lock shopware/core v6.7.13.0); PHP 8.5 (compose.yaml)
status: Draft
confidence: 64
updated: 2026-09-05
counts:
  rows: 3
  assumptions: {proposed: 2, accepted: 1, rejected: 0, suspect: 1}
  questions: {client: 1, blocking: 0, partner: 1, high: 1}
  clarifications: 2
export: {date: null, files: [], source_sha256: null, stale: false}
---

# RFP-0099 — Mini GmbH — Mini shop

## 1. Context

**At a glance.** Client Mini GmbH · budget "none stated" · effort unit PD · proposal due 2026-10-01.

**Source map.**

| # | Table (sheet / section) | Rows | Id column | Vendor columns (client's words) | Tokens | Effort unit | Locator |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Requirements | 3 | ID | Vendor: Compliance, Vendor: Comment, Vendor: Effort (PD) | Stock, Config, Plugin, Custom, Not offered | PD | rows 2–4 |

Minted IDs: none · Prefilled vendor cells: none · Ignored: none · Warnings: none

**Ground truth.** Shopware 6.7.13.0 Community (composer.lock) · Project plugins none · Partner assets none · Prior analyses reused none · KB pages platform/index.md · Agents PM C1; architect C1; QA no

## 2. Summary

| Scope | PD |
| --- | --- |
| Must (fixed-price scope) | 15.5 |
| Should | 2.5 |
| Could | 0 |
| of which Services | 0 |
| **Total** | 18 |

By area: STF: 15.5 · GEN: 0 · CAT: 2.5 · Foundation efforts: none · Overhead / buffer: 10% folded · buffer 5% separate · level buffers 0/10/25% · Plan variants: single variant · Blocking rows: none

| Dimension | Weight | Score | Points |
| --- | --- | --- | --- |
| Coverage evidence | 20 | 70 | 14.0 |
| Estimate basis | 20 | 70 | 14.0 |
| Scope lock | 20 | 40 | 8.0 |
| Platform decision | 15 | 70 | 10.5 |
| Integration & migration | 15 | 70 | 10.5 |
| Consistency | 10 | 70 | 7.0 |
| **Total** | **100** | | **64%** |

Weakest dimension: Scope lock — accept STF-01.a1; Q-1 open (high)

## 3. Global assumptions

Lines no single row owns. Same status grammar as §4.

| ID | Kind | Rows | Statement | PD saved | Risk to | Status |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | assume | STF-01..STF-03 | The theme extends the default Storefront theme; stock components are restyled, not rebuilt | STF-01 −3 · CAT-03 −1 | client | [ ] |
| X-1 | exclude | GEN-02 | Hosting is provided by the client (RFP section 4) | | | rfp |
| RC-1 | clarify | STF-01 | Four breakpoints only, no pixel-perfect commitment | | client, CQ-2 | 2026-09-04 |

## 4. Requirement analysis

| ID | Kind | Prio | Class | L/M/H | Lvl | PD | Text | Evidence / risk | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STF-01 | req | Must | custom | 12/16/22 | vague | 15.5 | Theme plugin extending @Storefront with SCSS tokens and block overrides. Includes foundation: theme base (4 PD). | pm: not-stock (docs Themes 6.7.0.0+); arch: ThemeInterface | estimated |
| STF-01.a1 | assume | | | | | −5 | Availability is display-only from the async sync, no live ERP call | risk to client | [ ] |
| STF-01.a2 | assume | | config | | | −2 | Product sheet is a print stylesheet, no server PDF | risk to client | accepted 2026-09-01 |
| STF-01.c1 | clarify | | | | | | Branch stock shown from synced fields, central stock sellable | client, CQ-2 | 2026-09-04 |
| GEN-02 | req | Must | commitment | 0/0/0 | detailed | 0 | No development — commitment: hosting recommendation stated in the offer | pm: confirmed-stock (composer.lock) | estimated |
| CAT-03 | req | Should | config | 1/2/4 | medium | 2.5 | Packaging units via purchaseSteps and packUnit; cart rounding message via snippet | pm: config (ProductDefinition.php:188); arch: ProductCartProcessor.php:299 | provisional, CQ-1 |
| CAT-03.a1 | assume | | | | | −1 | Quantities round up silently; no correction list before add-to-cart | risk to client | [ ] suspect |

Kinds: `req` one per source row · `assume` `<ROW>.a<n>` · `clarify` `<ROW>.c<n>`.

## 5. Open questions

### CQ-1 · CAT-03 · blocking: no
Does the CSV quick order list corrected lines before adding to the cart?
- [ ] A — yes, a correction list is shown first
- [ ] B — no, quantities are corrected silently
- [ ] Other:
Until answered we assume option B.

### Q-1 · high · §6
Which plan is offered?
- [ ] A — Evolve (recommended): B2B Components as shipped, Must stays at 15.5 PD
- [ ] B — Community: B2B rows become custom, Must +20 PD
- [ ] Other:
Until answered we assume option A.

Not sent — cap: none

## 6. Approach

| Item | Decision | Reason (rows served, source) | Alternative · PD delta |
| --- | --- | --- | --- |
| Plan | Evolve | B2B Components (STF-01) | Community: +20 PD |
| Hosting | _TBD_ | | |
| PSP | _TBD_ | | |
| CMP | _TBD_ | | |

| Interface | Pattern | Owner split | Risk |
| --- | --- | --- | --- |
| ERP → shop master data | queue consumers, idempotent upserts | bidder: shop side; ERP partner: API pages | field mapping late |

| Migration object | Approach | Volume | Tool | Reuse |
| --- | --- | --- | --- | --- |
| products | Import/Export profile | 25,000 SKUs | migration assistant | none |

## 7. Log

Append-only. Never a transcript.

| ID | Date | Topic | Decision |
| --- | --- | --- | --- |
| C-1 | 2026-09-01 | accepted | STF-01.a2 accepted; STF-01 mid 16 → 14, class config on acceptance |
| K-1 | 2026-09-01 | PM vs architect on CAT-03 | resolved: config per architect's cited mechanism |
