# Portos Read-Only Sync And Fiscal Documents Design

**Date:** 2026-04-12

## Goal
Move manager-facing legal/fiscal operations out of ad-hoc local admin state into server-backed flows without writing configuration into Portos/eKasa. The POS system must keep its own company identity profile, compare it against Portos read-only data, and provide a dedicated admin screen for searching fiscal documents by data visible on the printed receipt.

## Non-Goals
- Do not call Portos write endpoints for identities or settings.
- Do not modify Portos files, service configuration, or `%ProgramData%`.
- Do not generate/import XML into Portos in this iteration.
- Do not implement broader legal flows such as `paragón`, outage reporting, or mobile register GPS reporting.

## Scope
### 1. Server-backed company identity profile
The system will store legal/identity data in its own database instead of browser `localStorage`. This profile represents what the business considers the authoritative identity values for the POS deployment.

Fields in scope:
- business name
- ICO
- DIC
- IC DPH
- registered address
- branch / sale point name
- sale point address
- cash register code
- contact email / phone for internal display

### 2. Read-only Portos sync
The backend will read current Portos state and current Portos identity over HTTP and compute a normalized comparison against the stored company profile.

The UI will show:
- current local company profile
- current Portos identity snapshot
- mismatch status by field
- last comparison timestamp
- operator warning that identity changes must still be applied in Portos/eKasa through the official process outside this POS

### 3. Fiscal documents page
The admin will gain a dedicated `Fiškálne doklady` screen. Managers/admins must be able to:
- search by Portos/internal receipt identifier (`receiptId`)
- search by `externalId`
- search by `cashRegisterCode + year + month + receiptNumber`
- inspect linked order/payment information
- view OKP, receipt number, process date, source type, result mode, storno status
- execute storno from the found document without manually entering `paymentId`

## Architecture
### Backend
- Add a new server-side table for the company profile.
- Add a new server route module for company profile CRUD + read-only Portos comparison.
- Add a new server route module for fiscal document search/list/detail by printed-receipt identifiers.
- Keep existing payment and storno runtime behavior, but let fiscal-document lookup feed storno without requiring the manager to know DB payment IDs.

### Frontend Admin
- Add a new route/page `fiscal-documents`.
- Keep existing `settings.js` page, but move identity/compliance data to backend persistence and add Portos mismatch/compliance messaging there.
- Preserve purely local UI settings if they are unrelated to legal identity and would otherwise cause unnecessary refactoring.

## Data Model
### `company_profile`
One-row logical profile for the current deployment.

Suggested fields:
- `id`
- `businessName`
- `ico`
- `dic`
- `icDph`
- `registeredAddress`
- `branchName`
- `branchAddress`
- `cashRegisterCode`
- `contactPhone`
- `contactEmail`
- `createdAt`
- `updatedAt`

### Fiscal document search model
No new fiscal-document storage is required. Existing `fiscal_documents` already stores the needed fields:
- `receiptId`
- `externalId`
- `cashRegisterCode`
- `receiptNumber`
- `okp`
- `processDate`
- `paymentId`
- `orderId`
- `sourceType`
- `resultMode`

## API Design
### Company profile
- `GET /api/company-profile`
  Returns stored local company profile.
- `PUT /api/company-profile`
  Stores local company profile. Manager/admin only.
- `GET /api/company-profile/portos-compare`
  Returns:
  - local profile
  - Portos snapshot
  - normalized field-by-field comparison
  - mismatch summary
  - connectivity / certificate snapshot

### Fiscal documents
- `GET /api/fiscal-documents/search`
  Query params:
  - `receiptId`
  - `externalId`
  - `cashRegisterCode`
  - `year`
  - `month`
  - `receiptNumber`
  - optional `okp`
  Returns matching fiscal documents with linked payment/order metadata.

- `GET /api/fiscal-documents/:id`
  Returns a single fiscal document plus linked payment/order context and storno eligibility.

- `POST /api/fiscal-documents/:id/storno`
  Manager/admin only. Resolves the linked payment/order internally and reuses the existing Portos storno flow.

## UX
### Settings page
- Add a server-backed identity form section.
- Add a `Portos porovnanie` card:
  - local values
  - Portos values
  - mismatch badges
  - warning text about official external update process
- Keep current local-only settings for appearance/receipt formatting unless they are explicitly moved in a later task.

### Fiscal documents page
- Search form with three modes:
  - `Identifikátor dokladu`
  - `External ID`
  - `Kód pokladnice + rok + mesiac + číslo dokladu`
- Results list/table
- Detail card for selected document
- `Vytlačiť kópiu` and `STORNO` actions where allowed

## Validation And Security
- Only manager/admin can access Portos comparison and fiscal document storno/search endpoints.
- Server validates that at least one supported search mode is present.
- Search endpoints must not expose unrelated documents when query is incomplete.
- The system must never call Portos identity/settings write endpoints in this feature.

## Testing
- Route tests for company profile get/update.
- Route tests for Portos comparison using mocked Portos HTTP responses.
- Route tests for fiscal document search by `receiptId`, `externalId`, and `cashRegisterCode+year+month+receiptNumber`.
- Route tests for storno via fiscal-document endpoint.
- UI smoke verification for admin navigation and data rendering.

## Risks
- Current admin settings are local-only; partial migration must avoid breaking appearance/receipt preferences.
- Portos identity reads may be unavailable or return partial data; comparison UI must degrade gracefully.
- Older fiscal documents may not always have a complete identifier set; UI should surface what is and is not available instead of hiding documents.
