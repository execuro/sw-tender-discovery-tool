---
state: In progress
regime: T-shirt
source-sha256:
  rfp-0101-hartmann.xlsx: a89f1f97e3596bcc383a0adbf6b9f92b914216a2f43950291f15a29b43114250
slug: rfp-0101-hartmann
client: Hartmann Industriebedarf
tender-type: RFP
---
# RFP-0101 — Hartmann Industriebedarf

## 1. Context

Client: Hartmann Industriebedarf. Tender type: RFP. Source: `rfp-0101-hartmann.xlsx` (client ids).
Detected: Shopware 6.6, Beyond Edition, no existing project.

### Project information

| Parameter | Value | Source |
| --- | --- | --- |
| Business model | B2B wholesale, MRO distributor | 1 Company & Context r4 |
| Markets | Germany, Austria | 1 Company & Context r5 |
| Languages | German, English | 1 Company & Context r6 |
| Currencies | Euro | 1 Company & Context r7 |
| Sales channels | Storefront, sales rep portal | 1 Company & Context r8 |
| Customers & groups | B2B only, tiered customer groups | 1 Company & Context r9 |
| Products / SKUs | not stated |  |
| Categories & attributes | not stated |  |
| Media volume | not stated |  |
| Catalogue update frequency & master system | Daily, ERP is master | 1 Company & Context r10 |
| Price model | Customer-specific net terms, negotiated per account | 1 Company & Context r11 |
| Orders per day (avg / peak) | not stated |  |
| Traffic & peak users | not stated |  |
| Current platform | Legacy in-house shop | 1 Company & Context r12 |
| Leading systems (ERP / PIM / CRM) | SAP ERP | 1 Company & Context r13 |
| Data to migrate | Customers, orders, products | 1 Company & Context r14 |
| Target go-live | not stated |  |
| Shopware version / edition / plan | Shopware 6.6, Beyond Edition | 1 Company & Context r15 |

### Not taken from the source

| Source | Text | Why |
| --- | --- | --- |

## 2. Totals

<!-- totals:begin -->
<!-- totals:end -->

## 3. Global assumptions and exclusions

### Assumptions

- Standard German B2B tax rules apply; no custom tax logic assumed.

### Exclusions

- Commercial terms with the payment service provider are out of scope for this tool.

## 4. Scope items

### Functional · Requirements

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HIB-01 | Must | Customers can create an account and log in. | OOTB | high | — (0 PD) | Stock Shopware customer accounts cover this out of the box. |  |  | kb: Customer accounts | confirmed 2026-09-01 |
| HIB-02 | Should | Show stock per branch on the product page. | Extension | medium | M (4 PD) | We extend the storefront product page with a branch-level stock panel. | - Branch stock comes from the nightly ERP sync | Ask sales whether live stock is a hard requirement | kb: Stock display · Storefront | estimated |
| HIB-03 | Could | The client's requirement text is too vague to size yet. |  |  |  |  |  |  |  | blocked CQ-1 |

### Non-functional · Compliance

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMP-01 | Must | Provide an audit trail of every price change for the last seven years. | Custom | low | XL (25 PD) | We build a dedicated audit-trail module for pricing changes. |  |  | failed: no stock or project feature to extend | failed |

## 5. Questions

### CQ-1 · HIB-03

Does the client need real-time stock levels, or is a daily sync enough?
- [ ] A — real-time stock — effect: adds an ERP webhook integration
- [ ] B — daily sync — effect: no additional integration, stock shown from the nightly sync
Fallback: B

## 6. Integrations

## 7. Glossary

## 8. Log
