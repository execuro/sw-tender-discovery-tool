---
state: In progress
regime: profile
source-sha256:
  rfp-0103-sample-prose.pdf: 9f8e7d6c5b4a392817f0e1d2c3b4a5968778869504a3b2c1d0efedcba098765
slug: rfp-0103-sample-prose
client: Prose Sample Ltd
tender-type: project plan
---
# RFP-0103 — Prose Sample Ltd

## 1. Context

Client: Prose Sample Ltd. Tender type: project plan. Source: `rfp-0103-sample-prose.pdf`
(prose; scope items extracted by the skill, no client id or priority column).
Detected: Shopware 6.6, Beyond Edition, greenfield.

### Project information

| Parameter | Value | Source |
| --- | --- | --- |
| Business model | not stated |  |
| Markets | not stated |  |
| Languages | not stated |  |
| Currencies | not stated |  |
| Sales channels | not stated |  |
| Customers & groups | not stated |  |
| Products / SKUs | not stated |  |
| Categories & attributes | not stated |  |
| Media volume | not stated |  |
| Catalogue update frequency & master system | not stated |  |
| Price model | not stated |  |
| Orders per day (avg / peak) | not stated |  |
| Traffic & peak users | not stated |  |
| Current platform | Greenfield, no current platform | PDF p1 |
| Leading systems (ERP / PIM / CRM) | not stated |  |
| Data to migrate | not stated |  |
| Target go-live | not stated |  |
| Shopware version / edition / plan | Shopware 6.6, Beyond Edition | PDF p1 |

### Not taken from the source

| Source | Text | Why |
| --- | --- | --- |
| PDF #7 | Table of contents | not a requirement |

## 2. Totals

<!-- totals:begin -->
<!-- totals:end -->

## 3. Global assumptions and exclusions

### Assumptions

### Exclusions

## 4. Scope items

### Functional · Catalogue

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CAT-1 |  | The shop must list products in categories. | OOTB | high | 0 PD | Stock category listing covers this. |  |  | kb: Category listing | confirmed 2026-09-10 |
| CAT-2 |  | Products need a configurable bundle option. | Extension | medium | 9.5 PD | We extend the product page with a bundle configurator. | - Bundles are limited to products already in the same category | Confirm bundle depth with the client | kb: Product configurator | estimated |

### Functional · Checkout

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CHK-1 |  | The shop needs a fully custom multi-step B2B approval workflow. | Custom | low | 30 PD | We build a dedicated approval workflow module. |  |  | reopened 2026-09-12: profile change re-estimated the effort | reopened |

## 5. Questions

### CQ-1 · CHK-1

How many approval steps does the client's process require?
- [ ] A — two steps — effect: smaller workflow engine
- [x] B — up to five steps — effect: a configurable step engine
Fallback: A
Answered 2026-09-11: B

## 6. Integrations

## 7. Glossary

## 8. Log
