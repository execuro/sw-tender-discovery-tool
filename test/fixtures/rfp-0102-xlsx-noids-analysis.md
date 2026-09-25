---
state: In progress
regime: T-shirt
source-sha256:
  rfp-0102-b2b-ecommerce-smb.xlsx: 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80
slug: rfp-0102-b2b-ecommerce-smb
client: SMB Trading Co
tender-type: RFI
---
# RFP-0102 — SMB Trading Co

## 1. Context

Client: SMB Trading Co. Tender type: RFI. Source: `rfp-0102-b2b-ecommerce-smb.xlsx` (no ID column;
ids generated `<sheet prefix>-<n>` from the topic name, SI-2).
Detected: Shopware 6.6, Beyond Edition, project not yet started.

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
| Current platform | not stated |  |
| Leading systems (ERP / PIM / CRM) | not stated |  |
| Data to migrate | not stated |  |
| Target go-live | not stated |  |
| Shopware version / edition / plan | Shopware 6.6, Beyond Edition | operator |

### Not taken from the source

| Source | Text | Why |
| --- | --- | --- |

## 2. Totals

<!-- totals:begin -->
<!-- totals:end -->

## 3. Global assumptions and exclusions

### Assumptions

### Exclusions

## 4. Scope items

### Functional · B2B Requirements

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BR-1 | Must | Customers can request a quote instead of buying directly. | Configuration | high | XS (0.5 PD) | We configure a quote request flow with Rule Builder and Flow Builder. |  |  | kb: Quote requests | confirmed 2026-09-05 |
| BR-2 | Should | Integrate with the client's existing PIM system. | ISV | medium | M (4 PD) | An existing Store extension covers the PIM connector; we install, configure and map the fields. |  |  | isv: PIM Connector · Acme Software · 6.5, 6.6 · https://store.shopware.com/pim-connector | estimated |

### Project & services · Training

| ID | Prio | Requirement | Requirement Coverage | Confidence | Estimation | Client Response | Assumptions | Internal note | References | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NC-1 | Must | Provide operator training after go-live. | — | high | XS (0.5 PD) |  |  |  |  | queued |

## 5. Questions

### Q-1 · NC-1

Is one half-day training session enough, or does the client want a recorded session too?

## 6. Integrations

## 7. Glossary

## 8. Log
