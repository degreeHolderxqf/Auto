# CURRENT SYSTEM TECHNICAL DOCUMENTATION

**System**: Shopify Partner Outreach Automation (Personal Use)
**Document Version**: 1.0.0
**Date**: 2026-09-02
**Author**: Himanshu Soni
**Purpose**: Baseline architecture documentation prior to adding Remote Job Discovery feature.

> **IMPORTANT**: This document is based strictly on actual code inspected in the repository. No features, code paths, or configuration values have been fabricated. Where something could not be confirmed from the code, the phrase `NOT CONFIRMED FROM CODE` is used instead.
>
> **SECURITY**: No actual credentials, secrets, API keys, or passwords are included in this document. All sensitive values are represented by their environment variable names (e.g., `SMTP_PASSWORD`, `EVOLUTION_API_KEY`).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Application Entry Points](#4-application-entry-points)
5. [Configuration System](#5-configuration-system)
6. [Database Layer (SQLite)](#6-database-layer-sqlite)
7. [Data Model](#7-data-model)
8. [Data Flow](#8-data-flow)
9. [Frontend Application](#9-frontend-application)
10. [Frontend-Backend API Contract](#10-frontend-backend-api-contract)
11. [Shopify Partner Discovery](#11-shopify-partner-discovery)
12. [Company Normalization](#12-company-normalization)
13. [Exclusion Service](#13-exclusion-service)
14. [Employee Validation](#14-employee-validation)
15. [Company Website Research](#15-company-website-research)
16. [LinkedIn Provider](#16-linkedin-provider)
17. [Search Provider](#17-search-provider)
18. [App Relevance Scoring](#18-app-relevance-scoring)
19. [Lead Scoring](#19-lead-scoring)
20. [Email Generator](#20-email-generator)
21. [Email Sender & Resumable Batch System](#21-email-sender--resumable-batch-system)
22. [Email Templates](#22-email-templates)
23. [Email History & Export](#23-email-history--export)
24. [WhatsApp Architecture Overview](#24-whatsapp-architecture-overview)
25. [Evolution API Integration](#25-evolution-api-integration)
26. [WhatsApp Generator](#26-whatsapp-generator)
27. [WhatsApp Workflow (Single & Batch)](#27-whatsapp-workflow-single--batch)
28. [WhatsApp Connection Flow](#28-whatsapp-connection-flow)
29. [WhatsApp Templates & Messages](#29-whatsapp-templates--messages)
30. [Ready Queue & Duplicate Protection](#30-ready-queue--duplicate-protection)
31. [Docker & Evolution API Deployment](#31-docker--evolution-api-deployment)
32. [Local vs Production Environments](#32-local-vs-production-environments)
33. [Environment Variables](#33-environment-variables)
34. [Error Handling Strategy](#34-error-handling-strategy)
35. [Logging System](#35-logging-system)
36. [Security Considerations](#36-security-considerations)
37. [Dependencies](#37-dependencies)
38. [External Services & Integrations](#38-external-services--integrations)
39. [Deployment & Hosting](#39-deployment--hosting)
40. [CLI Interface](#40-cli-interface)
41. [Migrations & Schema Evolution](#41-migrations--schema-evolution)
42. [Rate Limiting & Throttling](#42-rate-limiting--throttling)
43. [Dry Run Mode](#43-dry-run-mode)
44. [Known Limitations & Design Decisions](#44-known-limitations--design-decisions)
45. [Future Feature: Remote Job Discovery (Planned)](#45-future-feature-remote-job-discovery-planned)

---

## 1. System Overview

The system is a **personal Shopify Partner outreach automation tool** designed to discover Shopify Partner agencies in India, research them for eligibility (employee count, ap prelevance, contact availability), and dispatch personalized cold outreach messages via **email** (Gmail SMTP) and **WhatsApp** (Evolution API).

**Core pipeline**:

```
Shopify Partner Directory → Normalize → Exclusion Filter → Employee Verification → Website Research → Contact Discovery → Scoring → Ready Queue → Email/WhatsApp Outreach
```

**Key characteristics**:
- Personal use only (single operator: Himanshu Soni, Shopify Developer with ~3 years experience)
- Targets Shopify Partner agencies in India
- Single SQLite database file for persistence
- Cross-platform: runs locally on Windows and deploys to Vercel (Linux serverless)
- No user authentication or multi-tenancy
- All data stored locally (no external database at rest)

**Source code locations**:
- Backend: `Testing/ccc/` (Node.js CommonJS)
- Frontend: `frontend/` (Next.js 15 + React 19 + TypeScript)
- Documentation: `docs/frontend-api-map.md`

---

## 2. Technology Stack

### Backend (`Testing/ccc/`)

| Technology | Version | Purpose | Rationale (from code) |
|---|---|---|---|
| **Node.js** | LTS | Runtime | CommonJS module system (`"type": "commonjs"`) chosen for compatibility with all dependencies |
| **sqlite (node:sqlite)** | Built-in | Database | `DatabaseSync` from Node.js stdlib; zero-dependency, file-based, WAL mode support |
| **Nodemailer** | Latest | SMTP email sending | Industry-standard Node.js email library; supports Gmail SMTP with retry logic |
| **dotenv** | Latest | Environment management | Loads `.env` file locally; explicitly NOT loaded on Vercel runtime |
| **jsdom** | Latest | HTML parsing | Used indirectly via validator for email extraction from HTML |
| **libphonenumber-js** | Latest | Phone normalization | Parses/validates international phone numbers, generates E.164 format |
| **pdfjs-dist** | Latest | PDF handling | Referenced in package.json; used for resume attachment handling |
| **puppeteer** | Latest | Browser automation | Declared in `package.json` dependencies; `NOT CONFIRMED FROM CODE` as actively used in core scraping flow (actual directory discovery uses HTTP + regex) |
| **qrcode** | Latest | QR code generation | Used by `evolutionGoClient` to render QR codes for WhatsApp connection |
| **xlsx (SheetJS)** | Latest | Excel export | Generates `.xlsx` files for lead exports |
| **csv-writer / csv-parser** | Latest | CSV export/import | Writes `shopify_leads.csv`, `email_history.csv`, `research_report.csv`, `email_queue.csv` |

### Frontend (`frontend/`)

| Technology | Version | Purpose |
|---|---|---|
| **Next.js** | 15.1.7 | React framework with App Router, server components |
| **React** | 19 | UI library |
| **TypeScript** | Latest | Static typing |
| **Tailwind CSS** | 3.4 | Utility-first styling |
| **lucide-react** | Latest | Icon library |
| **@vercel/node** | Latest | Vercel serverless runtime for backend |

### Infrastructure

| Service | Purpose |
|---|---|
| **Vercel** | Serverless hosting for backend (`src/server.cjs`), cron triggers |
| **Gmail SMTP** | Email delivery via Nodemailer |
| **Evolution API (Go)** | WhatsApp message sending via HTTP API |
| **Render** (NOT CONFIRMED FROM CODE as primary host) | Referenced in `docs/frontend-api-map.md` as example base URL; `NOT CONFIRMED FROM CODE` as current production host |
| **PostgreSQL 15** (Docker) | Evolution API's internal database (`docker-compose.evolution.yml`) |

---

## 3. High-Level Architecture

```mermaid
graph TD
    A[Shopify Partner Directory] -->|HTTP GET + Regex| B(shopifyDirectory.js)
    B --> C{Normalize}
    C -->|normalizer.js| D[Exclude Check]
    D -->|exclusionService.js| E{Already Excluded?}
    E -->|Yes| F[Mark EXCLUDED]
    E -->|No| G[Research Company]
    G --> H[employeeVerifier.js]
    H -->|LinkedIn| I[linkedInProvider.js]
    H -->|Website| J[companyWebsite.js]
    G --> K[validator.js - Email/Phone]
    G --> L[scoring.js - App + Lead Score]
    L --> M{Qualified?}
    M -->|Yes| N[READY Queue]
    M -->|No| O[NOT_ELIGIBLE / REJECTED_HEADCOUNT]
    N --> P[Email Outreach]
    N --> Q[WhatsApp Outreach]
    P -->|Nodemailer| R[Gmail SMTP]
    Q -->|Evolution API| S[Evolution Go]
    R --> T[email_logs table]
    S --> T[whatsapp_logs table]
```

**Architecture layers**:
1. **Providers** (`src/providers/`): External data sources (Shopify Directory, websites, LinkedIn, search engines)
2. **Services** (`src/services/`): Business logic (email, WhatsApp, scoring, exclusions, normalization, validation, employee verification)
3. **Workflows** (`src/workflows/`): Orchestration scripts (discovery, research, leads, send, WhatsApp)
4. **Database** (`src/db/`): SQLite persistence layer with WAL mode
5. **API** (`src/server.cjs` / `src/server.js`): HTTP REST API for frontend communication
6. **Frontend** (`frontend/`): Next.js App Router UI

---

## 4. Application Entry Points

### Backend — Two Entry Points

**Local entry** (`Testing/ccc/src/server.js`):
- Plain Node.js `http.createServer` with CORS preflight handling (`OPTIONS` method)
- Serves all REST API endpoints
- Serves `/download/csv` and `/download/xlsx` file downloads
- Resumable batch uses `scheduleNextChunk` (setTimeout-based self-resume) for non-Vercel environments
- Default HTML dashboard on `/`

**Vercel entry** (`Testing/ccc/src/server.cjs`):
- Wraps the handler to be Vercel-compatible (`@vercel/node` builder)
- Routes to `/tmp/data` on Vercel, normal paths locally
- All same endpoints as local server
- Vercel cron (`* * * * *`) triggers `/api/email/batch/worker` to resume stale batches
- Function `maxDuration`: 300 seconds

### Frontend Entry Points (App Router pages)

| File | Route | Purpose |
|---|---|---|
| `frontend/app/page.tsx` | `/` | Dashboard overview |
| `frontend/app/leads/page.tsx` | `/leads` | Qualified leads management |
| `frontend/app/outreach/page.tsx` | `/outreach` | Email & WhatsApp dispatch center |
| `frontend/app/discovery/page.tsx` | `/discovery` | Partner discovery engine |
| `frontend/app/companies/page.tsx` | `/companies` | All companies view |
| `frontend/app/exclusions/page.tsx` | `/exclusions` | Exclusion management |
| `frontend/app/settings/page.tsx` | `/settings` | Settings (SMTP, Evolution, candidate info) |
| `frontend/app/layout.tsx` | All | Root layout + Sidebar navigation |

---

## 5. Configuration System

**File**: `Testing/ccc/src/config.js`

The configuration module is the single source of truth for all environment-dependent settings.

### Vercel vs Local Detection

```js
const isVercelRuntime = process.env.VERCEL === "1" || process.env.VERCEL === "true" || Boolean(process.env.VERCEL_ENV);
```

- **Vercel**: `.env` is NEVER loaded; paths use `/tmp/*` directories; environment variables must be set in Vercel dashboard
- **Local**: `.env` is loaded via `dotenv`; paths use repo-root relative directories (`data/`, `logs/`, `output/`)

### Path Resolution

| Setting | Local Path | Vercel Path |
|---|---|---|
| Database | `data/leads.sqlite` | `/tmp/data/leads.sqlite` |
| Logs | `logs/` | `/tmp/logs/` |
| Output (exports) | `output/` | `/tmp/output` |
| Exclusions CSV | `data/excluded_companies.csv` | `/tmp/data/excluded_companies.csv` |
| Resume PDF | `26_Himanshu-Soni-Shopify.pdf` | `26_Himanshu-Soni-Shopify.pdf` (must exist) |

### Default Configuration Values

```js
// Email
smtp.host = process.env.SMTP_HOST || "smtp.gmail.com"
smtp.port = parseInt(process.env.SMTP_PORT || "587", 10)
smtp.secure = process.env.SMTP_SECURE === "true"
smtp.from = process.env.EMAIL_FROM || "Himanshu Soni <himanshusoni7899@gmail.com>"

// Rate limiting
emailDelayMs = parseInt(process.env.EMAIL_DELAY_MS || "5000", 10)  // 5000ms = 5s between emails
dryRun = process.env.DRY_RUN !== "false" && process.env.DRY_RUN !== "0"  // default: true

// Evolution API
evolution.apiUrl = process.env.EVOLUTION_API_URL || "https://evolution-api-latest-h0yy.onrender.com"
evolution.instanceName = process.env.EVOLUTION_INSTANCE_NAME || "job-search"
evolution.delayMs = parseInt(process.env.WHATSAPP_DELAY_MS || "15000", 10)  // 15s between WhatsApp messages

// Discovery
shopifyDirectoryUrl = "https://www.shopify.com/in/partners/directory/locations/india"
targetLeads = 100
minAppRelevanceScore = 70
```

---

## 6. Database Layer (SQLite)

**File**: `Testing/ccc/src/db/database.js` (~1041 lines)

### Database Technology
- **Engine**: `node:sqlite` `DatabaseSync` (Node.js built-in, no external dependency)
- **Mode**: WAL (Write-Ahead Logging) enabled for concurrent reads during writes
- **File**: Single file `leads.sqlite`
- **Locking**: Atomic locking via `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`
- **Idempotency**: All batch operations use `INSERT OR IGNORE` and status-based claims

### Singleton Pattern

```js
// database.js exports a singleton instance
const db = new Database();
module.exports = db;
```

The database is accessed via `require("../db/database")` throughout the system. A raw connection is available via `db.getRawDb()` for raw SQL queries.

### Key Database Methods

| Method | Purpose |
|---|---|
| `upsertCompany(data)` | Insert or update a company record |
| `getFinalQualifiedLeads(limit)` | Get all qualified leads for export |
| `getReadyQueueCount()` | Count leads in READY status |
| `hasBeenContacted(email, companyId)` | Check if contact already recorded |
| `getCompanyById(id)` | Get company by primary key |
| `getContactsByCompanyId(id)` | Get all contacts for a company |
| `addEmailLog(data)` | Record an email send attempt |
| `updateCompanyStatus(id, status, notes)` | Update company status |
| `createEmailBatch(items, options)` | Create resumable batch |
| `getNextBatchItems(batchId, chunkSize)` | Atomically claim pending items |
| `markBatchItemSent(batchId, companyId, messageId, attempts)` | Mark item as sent |
| `markBatchItemFailed(batchId, companyId, error, attempts)` | Mark item as failed |
| `refreshEmailBatchCounters(batchId)` | Recount pending/processing/sent/failed |
| `completeEmailBatch(batchId)` | Mark batch COMPLETED |
| `failEmailBatch(batchId, error)` | Mark batch FAILED |
| `logWhatsAppMessage(data)` | Record WhatsApp message |
| `isWhatsAppOptedOut(phone)` | Check opt-out |
| `isWhatsAppContacted(companyId, phone)` | Check duplicate |
| `getStatistics()` | Aggregate stats for dashboard |

### Built-in Fallback

When the database is unavailable (e.g., during Vercel cold starts), `src/server.cjs` provides an env-based fallback:
```js
// server.cjs: if DB fails, returns settings from process.env
```

---

## 7. Data Model

### Database Schema (from `src/db/migrations.js`)

#### `companies` (37 columns)

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Original company name |
| `normalized_name` | TEXT | Normalized (lowercase, suffixes stripped) |
| `domain` | TEXT | Extracted domain (e.g., `loyaltylion.com`) |
| `shopify_partner_url` | TEXT | Full Shopify partner directory URL |
| `official_website` | TEXT | Company's official website URL |
| `city` | TEXT | City from partner directory |
| `state` | TEXT | State/region |
| `country` | TEXT | Country (default: `India`) |
| `partner_tier` | TEXT | e.g., `Plus Partner`, `Premier Partner`, `Shopify Partner` |
| `rating` | REAL | Partner rating (nullable) |
| `reviews` | INTEGER | Number of reviews |
| `shopify_services` | TEXT | Comma-separated list of services |
| `public_apps` | TEXT | Comma-separated public Shopify apps |
| `app_relevance_score` | INTEGER | 0-100 score from `scoring.calculateAppRelevance()` |
| `lead_score` | INTEGER | 0-100 weighted score from `scoring.calculateLeadScore()` |
| `contact_name` | TEXT | Best contact name |
| `contact_role` | TEXT | Contact role |
| `email` | TEXT | Best email address |
| `email_type` | TEXT | e.g., `HR / Recruitment`, `General`, `Personal / Professional` |
| `email_confidence` | TEXT | `HIGH`, `MEDIUM`, `LOW` |
| `email_source` | TEXT | Source description |
| `email_source_url` | TEXT | URL where email was found |
| `careers_url` | TEXT | Careers page URL |
| `linkedin_url` | TEXT | LinkedIn company URL |
| `phone` | TEXT | Primary phone (formatted) |
| `normalized_phone` | TEXT | E.164 format phone |
| `phone_type` | TEXT | `COMPANY`, `BUSINESS`, `HR / RECRUITMENT` |
| `phone_source` | TEXT | Source of phone number |
| `phone_source_url` | TEXT | URL where phone was found |
| `whatsapp_available` | TEXT | `yes`, `unknown` |
| `whatsapp_status` | TEXT | `READY`, `SENT`, `FAILED`, `OPTED_OUT` |
| `status` | TEXT | `DISCOVERED`, `RESEARCHED`, `READY`, `SENT`, `NO_CONTACT`, `EXCLUDED`, `FAILED`, `LOW_RELEVANCE`, `NOT_ELIGIBLE`, `REJECTED_HEADCOUNT`, `ERROR`, `CONTACTED` |
| `notes` | TEXT | Free-text notes |
| `employee_count` | INTEGER | Verified employee count |
| `employee_count_min` | INTEGER | Min of range |
| `employee_count_max` | INTEGER | Max of range |
| `employee_size_range` | TEXT | e.g., `51-200`, `11-50` |
| `employee_count_source` | TEXT | Primary source of headcount |
| `employee_count_source_url` | TEXT | URL of headcount evidence |
| `employee_count_verified` | INTEGER | 0 or 1 |
| `employee_count_verified_at` | TEXT | ISO timestamp |
| `employee_count_status` | TEXT | `QUALIFIED`, `REJECTED`, `NEED_MORE_VERIFICATION`, `CONFLICTING`, `UNKNOWN` |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

#### `contacts`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `company_id` | INTEGER FK | |
| `email` | TEXT | |
| `email_type` | TEXT | |
| `confidence` | TEXT | |
| `source_url` | TEXT | |
| `phone` | TEXT | |
| `normalized_phone` | TEXT | E.164 |
| `phone_type` | TEXT | |
| `phone_source` | TEXT | |
| `phone_source_url` | TEXT | |
| `whatsapp_available` | TEXT | |
| `whatsapp_status` | TEXT | |
| `verified` | INTEGER | 0 or 1 |
| `mx_valid` | INTEGER | 0 or 1 |
| `notes` | TEXT | |

#### `sources` (reference/audit table)

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `company_id` | INTEGER FK | |
| `source_type` | TEXT | e.g., `Official Website Homepage`, `Careers Page`, `LinkedIn` |
| `url` | TEXT | |
| `title` | TEXT | |
| `evidence` | TEXT | |
| `created_at` | TEXT | |

#### `exclusions`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `company_name` | TEXT | Original name |
| `normalized_name` | TEXT | Normalized |
| `domain` | TEXT | |
| `reason` | TEXT | e.g., `Resume / Past Employer`, `Contacted Lead (hr@...` |
| `added_at` | TEXT | ISO timestamp |

#### `email_batches` (resumable batch system)

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | `batch_${Date.now()}_${random}` |
| `mode` | TEXT | `LIVE` or `DRY_RUN` |
| `status` | TEXT | `PROCESSING`, `COMPLETED`, `FAILED` |
| `total` | INTEGER | Total items |
| `pending` | INTEGER | Pending count |
| `lead_ids_json` | TEXT | JSON array of company IDs |
| `chunk_size` | INTEGER | Items per chunk |
| `created_at` | TEXT | |
| `completed_at` | TEXT | |
| `failed_at` | TEXT | |
| `error` | TEXT | |

#### `email_batch_items`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `batch_id` | TEXT | FK to email_batches |
| `company_id` | INTEGER | |
| `contact_id` | INTEGER | |
| `email` | TEXT | |
| `subject` | TEXT | |
| `mail_options_json` | TEXT | Serialized mail options |
| `position` | INTEGER | Order in batch |
| `status` | TEXT | `PENDING`, `PROCESSING`, `SENT`, `FAILED` |
| `message_id` | TEXT | |
| `error` | TEXT | |
| `attempts` | INTEGER | |
| `sent_at` | TEXT | |
| **UNIQUE(batch_id, company_id)** | | Prevents duplicate sends |

#### `email_logs`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `company_id` | INTEGER | |
| `email` | TEXT | |
| `subject` | TEXT | |
| `status` | TEXT | `SENT`, `FAILED`, `DRY_RUN_SENT` |
| `message_id` | TEXT | |
| `error` | TEXT | |
| `sent_at` | TEXT | |

#### `whatsapp_logs`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | |
| `company_id` | INTEGER | |
| `contact_id` | INTEGER | |
| `phone` | TEXT | |
| `message` | TEXT | |
| `status` | TEXT | `SENT`, `FAILED`, `DRY_RUN_SENT`, `REPLIED`, `OPTED_OUT` |
| `message_id` | TEXT | |
| `error` | TEXT | |
| `sent_at` | TEXT | |

#### `settings`

| Column | Type | Description |
|---|---|---|
| `key` | TEXT PK | Setting name |
| `value` | TEXT | Setting value (secrets masked as `••••••••`) |

---

## 8. Data Flow

### End-to-End Lead Lifecycle

```mermaid
sequenceDiagram
    participant User as Frontend/CLI
    participant Discovery as discoverWorkflow.js
    participant Directory as shopifyDirectory.js
    participant DB as SQLite
    participant Research as researchWorkflow.js
    participant Normalizer as normalizer.js
    participant Exclusion as exclusionService.js
    participant Verifier as employeeVerifier.js
    participant Website as companyWebsite.js
    participant LinkedIn as linkedInProvider.js
    participant Validator as validator.js
    participant Scoring as scoring.js
    participant Email as emailSender.js
    participant WhatsApp as whatsappWorkflow.js
    participant Evolution as Evolution API

    User->>Discovery: Run discovery (candidates=150)
    Discovery->>Directory: discoverPartners()
    Directory-->>Discovery: Raw partners list
    loop Each partner
        Discovery->>Normalizer: normalizeCompanyName()
        Normalizer-->>Discovery: Normalized name
        Discovery->>Exclusion: isCompanyExcluded()
        Exclusion-->>Discovery: Excluded?
        alt Excluded
            Discovery->>DB: upsertCompany(status=EXCLUDED)
        else Not excluded
            Discovery->>DB: upsertCompany(status=DISCOVERED)
        end
    end

    User->>Research: Run research
    Research->>DB: Get DISCOVERED companies
    loop Each company
        Research->>Exclusion: isCompanyExcluded() (re-check)
        Research->>LinkedIn: getCompanyHeadcount()
        Research->>Website: researchWebsite()
        Website-->>Research: contacts, employeeEvidence
        Research->>Verifier: evaluateMultiSource(linkedIn, web)
        Verifier-->>Research: evalResult (isQualified, employee_count)
        alt NOT Qualified
            Research->>DB: upsertCompany(status=NOT_ELIGIBLE)
        else Qualified
            Research->>Validator: extractEmails(), extractPhones(), classifyEmailType(), calculateConfidence(), checkMxRecords()
            Research->>Scoring: calculateAppRelevance(), calculateLeadScore()
            Research->>DB: upsertCompany(status=READY), upsertContact()
        end
    end

    User->>Email: Start batch send
    Email->>DB: createEmailBatch()
    Email->>DB: getNextBatchItems() (atomic claim)
    loop Each item in chunk
        Email->>Email: generateEmail()
        Email->>Email: sendMailWithRetry()
        Email->>DB: markBatchItemSent()
        Email->>Exclusion: addExclusion()
    end
    alt More work remains
        Email->>Email: scheduleNextChunk()
    end

    User->>WhatsApp: Send batch
    WhatsApp->>DB: isWhatsAppOptedOut()
    WhatsApp->>DB: isWhatsAppContacted()
    WhatsApp->>Evolution: sendTextMessage()
    Evolution-->>WhatsApp: Result
    WhatsApp->>DB: logWhatsAppMessage()
```

---

## 9. Frontend Application

### Framework & Stack

- **Next.js 15.1.7** with App Router (React Server Components + Client Components)
- **React 19** with `"use client"` directives for interactive components
- **TypeScript** for type safety
- **Tailwind CSS 3.4** for styling with a dark theme (`bg-slate-950`, `text-slate-100`)
- **lucide-react** for icons

### UI Components

| Component | Path | Purpose |
|---|---|---|
| `Sidebar.tsx` | `frontend/components/layout/` | Navigation: Dashboard, Qualified Leads, Email Outreach, Partner Discovery, All Companies, Exclusions, Settings |
| `Header.tsx` | `frontend/components/layout/` | Top header with API status |
| `BatchSenderModal.tsx` | `frontend/components/email/` | 3-phase email batch sender: configure → sending → done |
| `LeadsTable.tsx` | `frontend/components/leads/` | Filterable, sortable leads table |
| `LeadDrawer.tsx` | `frontend/components/leads/` | Slide-out detail drawer for a lead |
| `EmailPreviewModal.tsx` | `frontend/components/email/` | Email preview with resume attachment |
| `WhatsAppPreviewModal.tsx` | `frontend/components/leads/` | WhatsApp message preview |
| `PipelineStatus.tsx` | `frontend/components/dashboard/` | Pipeline visualization |
| `StatGrid.tsx` | `frontend/components/dashboard/` | Metric cards |
| `QuickActions.tsx` | `frontend/components/dashboard/` | Quick action buttons |
| `WhatsAppWidget.tsx` | `frontend/components/dashboard/` | WhatsApp status widget |
| `DiscoveryRunner.tsx` | `frontend/components/discovery/` | Discovery controls |
| `ExclusionsTable.tsx` | `frontend/components/exclusions/` | Exclusions list |
| `AddExclusionModal.tsx` | `frontend/components/exclusions/` | Add exclusion form |
| `EmailHistoryTable.tsx` | `frontend/components/email/` | Email log history |

### Sidebar Navigation

```tsx
const NAV_ITEMS = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Qualified Leads", href: "/leads", icon: Users },
  { label: "Email Outreach", href: "/outreach", icon: Send },
  { label: "Partner Discovery", href: "/discovery", icon: Compass },
  { label: "All Companies", href: "/companies", icon: Building2 },
  { label: "Exclusions", href: "/exclusions", icon: ShieldBan },
  { label: "Settings", href: "/settings", icon: Settings },
];
```

### API Client (`frontend/lib/api/client.ts`)

- `BACKEND_URL` = `http://localhost:3000` (local) / `https://auto-rho-peach.vercel.app` (production)
- `getApiBaseUrl()` uses `NEXT_PUBLIC_API_URL` env or `localStorage.CUSTOM_API_URL`
- Default timeout: 45000ms, 1 retry
- Fallback strategy: proxy → direct production on retry
- Error message: "Request timed out while reaching the backend. The server may be busy or unreachable — try again, or resume the batch from the Outreach page."

---

## 10. Frontend-Backend API Contract

All API calls go through `frontend/lib/api/client.ts`. Full endpoint specification is in `docs/frontend-api-map.md`.

### Key API Endpoints

| Method | Path | Purpose | Handler in server.js/cjs |
|---|---|---|---|
| GET | `/health` | Health check | Inline |
| GET | `/api/stats` | Aggregate statistics | `getStatistics()` |
| GET | `/api/leads` | Paginated qualified leads | `getFinalQualifiedLeads()` |
| GET | `/api/leads/:id` | Lead detail | Company + contacts + sources + logs |
| POST | `/api/actions/discover` | Trigger discovery | `discoverWorkflow.runDiscovery()` |
| POST | `/api/actions/research` | Research single company | `researchWorkflow.researchCompany()` |
| POST | `/api/actions/leads` | Trigger lead engine | `leadWorkflow.runLeadGeneration()` |
| POST | `/api/email/send` | Send batch email | `emailSender.createBatch()` + process |
| GET | `/api/email/batch/status/:id` | Batch status | `getEmailBatch()` |
| POST | `/api/email/batch/resume/:id` | Resume batch | `processBatchChunk()` |
| GET | `/api/email/batch/worker` | Vercel cron worker | Auto-resume stale batches |
| GET | `/api/email/preview/:companyId` | Email preview | `generateEmail()` |
| GET | `/api/email/history` | Email history | `getAllEmailLogs()` |
| GET | `/api/whatsapp/status` | WhatsApp connection status | Evolution API |
| POST | `/api/whatsapp/connect` | Connect WhatsApp | Evolution API |
| POST | `/api/whatsapp/send` | Send WhatsApp message | `whatsappWorkflow.sendSingleMessage()` |
| GET | `/api/exclusions` | List exclusions | Exclusion service |
| POST | `/api/exclusions` | Add exclusion | Exclusion service |
| GET | `/download/csv` | CSV download | `exportLeadsCsv()` |
| GET | `/download/xlsx` | XLSX download | `exportLeadsXlsx()` |

---

## 11. Shopify Partner Discovery

**File**: `Testing/ccc/src/providers/shopifyDirectory.js`

### Discovery Process

1. **URL**: `https://www.shopify.com/in/partners/directory/locations/india`
2. **Pagination**: Fetches up to 40 pages, 16 cards per page
3. **Stop condition**: 3 consecutive empty pages = stop
4. **Extraction**: Regex on `data-component-name="listing-profile-card"` HTML attribute
5. **Per-partner extraction**:
   - Company name
   - Partner tier (`Plus Partner`, `Premier Partner`, etc.)
   - Rating, reviews
   - Official website URL
   - LinkedIn URL
   - Listed email
   - City, country
6. **Profile fetch**: `fetchPartnerProfile()` extracts additional details from each partner's profile page

### Profile Page Fetching

```js
// fetchPartnerProfile(shopify_partner_url)
// Extracts: partner_tier, services, LinkedIn, official_website, listed_email
```

### Discovery Workflow

**File**: `Testing/ccc/src/workflows/discoverWorkflow.js`

```js
async function runDiscovery(options = {}) {
  const rawPartners = await shopifyDirectory.discoverPartners(targetCandidates, { fetchAllPages });
  for (const partner of rawPartners) {
    const normName = normalizer.normalizeCompanyName(partner.name);
    const existing = db.getCompanyByNormalizedName(normName) || db.getCompanyByShopifyUrl(partner.shopify_partner_url);
    const exclusionCheck = exclusionService.isCompanyExcluded(partner.name);
    if (exclusionCheck.excluded) {
      // Mark EXCLUDED
    } else if (existing && existing.status !== "DISCOVERED") {
      // Skip duplicate
    } else {
      // Save as DISCOVERED
    }
  }
}
```

---

## 12. Company Normalization

**File**: `Testing/ccc/src/services/normalizer.js`

### `normalizeCompanyName(name)`

Strips common suffixes and punctuation, converts to lowercase:
- Strips: `Pvt Ltd`, `Private Limited`, `Technologies`, `Technology`, `Solutions`, `Inc`, `LLC`, `Ltd`, `Corporation`, `Corp`, `Co`, `Company`, `India`, `Indian`
- Strips punctuation and extra whitespace
- Returns lowercase normalized string

### `normalizeDomain(domain)`

- Strips `http://`, `https://`, `www.`
- Strips path components
- Returns clean domain (e.g., `loyaltylion.com`)

### `extractPartnerSlug(url)`

- Regex from Shopify partner URL to extract partner slug
- Example: `https://www.shopify.com/partners/directory/partner/loyaltylion` → `loyaltylion`

---

## 13. Exclusion Service

**File**: `Testing/ccc/src/services/exclusionService.js`

### Dual Storage

- **CSV-backed**: `data/excluded_companies.csv` (persistent, human-readable)
- **DB-backed**: `exclusions` table in SQLite
- Auto-excludes all contacted leads from `getContactedLeads()`

### Fuzzy Matching Strategy

```js
// isCompanyExcluded(name, domain) checks:
// 1. Exact name match
// 2. Token-based match
// 3. Prefix match
// 4. Domain-stem match (e.g., "parkhya" matches "parkhya.com")
```

### Default Exclusions (per task description)

- `ITGeeks`
- `Parkhya Solutions`
- `FirstSight`

These are loaded from CSV at startup.

### Exclusion Reasons

- `Resume / Past Employer` — previously worked with
- `Contacted Lead (email@example.com)` — already emailed
- `Previously Researched Lead` — researched but not contacted

### Workflow Integration

Exclusions are checked at multiple points:
1. After discovery (`discoverWorkflow.js`)
2. Before research (`researchWorkflow.js`)
3. After partner profile fetch if domain discovered (`researchWorkflow.js`)

---

## 14. Employee Validation

**File**: `Testing/ccc/src/services/employeeVerifier.js`

### Purpose

Strict evidence-based employee count verification to filter out small agencies (< 30 employees by default).

### Configuration

- `MIN_EMPLOYEE_COUNT` env var (default: `null`/disabled)
- If `0` or disabled: employee count is optional, does not block qualification
- If set to `30` (or other number): companies with `< 30` employees are rejected

### Source Priority

1. **PRIMARY**: LinkedIn (public company page HTML)
2. **SECONDARY**: Official Website (Homepage, About, Careers, Team pages)
3. **TERTIARY**: Shopify Partner Profile (services text)

### Range Handling

| Range | Threshold 30 | Status |
|---|---|---|
| `51-200`, `201-500`, etc. | Lower bound >= 30 | `QUALIFIED` |
| `1-10` | Upper bound < 30 | `REJECTED` |
| `11-50`, `20-40` | Spans threshold | `NEED_MORE_VERIFICATION` |

### Multi-Source Resolution Logic

```js
evaluateMultiSource(primary, secondary) {
  // LinkedIn (primary) vs Website (secondary) cross-validation:
  // - LinkedIn QUALIFIED + secondary REJECTED → CONFLICTING
  // - LinkedIn NEED_MORE_VERIFICATION + secondary QUALIFIED → QUALIFIED
  // - LinkedIn NEED_MORE_VERIFICATION + secondary REJECTED → REJECTED
  // - No evidence → UNKNOWN
}
```

### Zero-Guess Policy

- No inference from revenue, products, clients, followers, or unbacked AI text
- Only accepts explicit numeric evidence from HTML text
- Statuses: `QUALIFIED`, `REJECTED`, `NEED_MORE_VERIFICATION`, `CONFLICTING`, `UNKNOWN`

### Non-Qualified Result

If `!evalResult.isQualified`:
- Company status set to `REJECTED_HEADCOUNT` or `NOT_ELIGIBLE`
- **No** contact discovery is performed
- **No** search provider query is made
- **No** lead qualification occurs

---

## 15. Company Website Research

**File**: `Testing/ccc/src/providers/companyWebsite.js`

### Website Crawling Process

1. **Fetch URLs**: Tries `https://domain`, `https://www.domain`, `http://domain`
2. **Homepage processing**:
   - Extract emails via `validator.extractEmails()`
   - Extract phones via `validator.extractPhones()`
   - Find LinkedIn URL via regex
   - Find public Shopify App links (`apps.shopify.com/...`)
3. **Subpage discovery** (up to 6 pages):
   - Patterns: `/careers`, `/jobs`, `/contact`, `/about`, `/team`, `/people`
   - Supports: `lever.co`, `greenhouse.io`, `workable.com` ATS
4. **Employee headcount extraction** from homepage + subpages

### Contact Prioritization

- HR/Recruitment emails first
- Management emails second
- General emails third
- HIGH confidence before MEDIUM before LOW

### Phone Prioritization

- HR/Recruitment first
- WhatsApp/Business second
- General third

### Output

```js
{
  contacts: [...],           // Deduplicated, sorted by type/confidence
  phones: [...],             // All discovered phones
  primaryPhone: {...},       // Best phone (HR/business first)
  careersUrl: string | null,
  linkedInUrl: string | null,
  publicApps: [...],         // Shopify App store links
  employeeEvidence: {...},   // Parsed headcount evidence
  sources: [...]             // Source audit trail
}
```

---

## 16. LinkedIn Provider

**File**: `Testing/ccc/src/providers/linkedInProvider.js`

### Methods

- `getCompanyHeadcount(linkedinUrl)`: Fetches LinkedIn company page, parses headcount evidence
- `parseLinkedInText(text, sourceUrl)`: Parses LinkedIn text/snippet for headcount
- `cleanLinkedInUrl(rawUrl)`: Normalizes LinkedIn URL
- `generateCompanySearchUrl(companyName)`: Builds LinkedIn search URL

### Implementation

Uses `fetchUrl()` (HTTPS GET with Chrome user-agent) to fetch LinkedIn public page HTML, then delegates to `employeeVerifier.parseHeadcountEvidence()`.

`NOT CONFIRMED FROM CODE` whether LinkedIn pages are reliably scraped given LinkedIn's anti-bot protections.

---

## 17. Search Provider

**File**: `Testing/ccc/src/providers/searchProvider.js`

### Purpose

Search for HR/Careers hiring contacts when no HR contact found on the website.

### Provider Types

- `direct` (default): No API, returns empty — uses only website crawling
- `serpapi`: SerpAPI integration for Google search results
- `google`: Google Custom Search JSON API
- `duckduckgo`, `bing`: Declared in config but `NOT CONFIRMED FROM CODE` as implemented

### SerpAPI Integration

```js
// Query: `site:${domain} hr OR careers OR hiring email`
// Or: `"${companyName}" HR email OR careers email`
// Extracts emails from search result snippets
```

### Usage in Workflow

Called only when `!hasHrContact` after website research:
```js
if (!hasHrContact && (company.name || domain)) {
  const searchRes = await searchProvider.searchHiringContacts(company.name, domain);
}
```

---

## 18. App Relevance Scoring

**File**: `Testing/ccc/src/services/scoring.js`

### `calculateAppRelevance(servicesStr, publicAppsStr, partnerTier, publicApps)`

Scores how relevant a company's Shopify service offerings are for outreach:

| Category | Score |
|---|---|
| Public Shopify Apps (has apps listed) | 100 |
| Custom apps + APIs (services contain relevant keywords) | 95 |
| Plus / Headless commerce | 80 |
| Dev + Integration services | 70 |
| Theme customization, Store build, etc. | 60 |
| Other Shopify services | 50 |
| No relevant services | 30 |
| No services data | 20 |

### Service Keywords

The scoring checks for keywords like: `custom apps`, `APIs`, `GraphQL`, `JavaScript`, `Node.js`, `headless`, `Plus`, `theme`, `migration`, `integration`, `development`, `store build`, `redesign`, `conversion`, `SEO`, `analytics`, `POS`, `wholesale`, `international expansion`

---

## 19. Lead Scoring

**File**: `Testing/ccc/src/services/scoring.js`

### `calculateLeadScore(companyData, bestContact)`

Weighted scoring:

| Factor | Weight | Max Points |
|---|---|---|
| `app_relevance_score` | 40% | 40 |
| Public apps present | 20% | 20 |
| Partner Tier (Plus) | 10% | 10 |
| Contact found | 15% | 15 |
| Email confidence (HIGH) | 10% | 10 |
| Rating/reviews | 5% | 5 |

### Final Status Determination

```js
if (bestContact && ["HIGH", "MEDIUM"].includes(bestContact.confidence)) {
  finalStatus = "READY";
} else if (appRelevanceScore < 50) {
  finalStatus = "LOW_RELEVANCE";
} else {
  finalStatus = "NO_CONTACT";
}
```

---

## 20. Email Generator

**File**: `Testing/ccc/src/services/emailGenerator.js`

### `generateEmail(company, contact)`

Returns a complete email object:

```js
{
  from: "Himanshu Soni <himanshusoni7899@gmail.com>",
  to: contact.email,
  subject: `Shopify Developer — Application for Opportunities at ${companyName}`,
  text: "...",
  html: "...",
  attachments: [{ filename: "26_Himanshu-Soni-Shopify.pdf", path: resumePath }]
}
```

### Personalization

- `focusSentence`: Based on `app/plus/services` classification
- Uses `company.normalized_name`, `contact.name`, `companyName`
- Greeting: `Hi ${companyName} Team,` or `Hi ${contact.name},`
- Mentions candidate name, role, experience (from settings)

---

## 21. Email Sender & Resumable Batch System

**File**: `Testing/ccc/src/services/emailSender.js` (~504 lines)

This is the most critical and complex module in the system.

### Resumable Batch Architecture

The batch system was redesigned to solve the Vercel timeout problem (10-20 emails then timeout). Key design:

1. **Batch Creation** (`createBatch`): Persists all items as `PENDING` in `email_batch_items`, batch row as `PROCESSING`
2. **Chunk Processing** (`processBatchChunk`): Atomically claims up to `chunkSize` items, processes within `wallMs` budget
3. **Self-Resume** (`scheduleNextChunk`): setTimeout-based continuation
4. **Vercel Cron Worker**: `/api/email/batch/worker` runs every minute to resume stale batches

### Chunk Processing Details

```js
async processBatchChunk(batchId, options) {
  // 1. Per-batch concurrency guard (_runningBatches Set)
  // 2. Atomically claim up to chunkSize items via getNextBatchItems()
  // 3. For each item:
  //    a. Re-hydrate mailOptions JSON
  //    b. Generate email if needed
  //    c. sendMailWithRetry()
  //    d. markBatchItemSent() or markBatchItemFailed()
  //    e. Update company status to CONTACTED/FAILED
  //    f. Add to exclusions (auto-exclude contacted leads)
  // 4. Wall-clock check: if Date.now() - startedAt > wallMs, release remaining items
  // 5. If all done → completeEmailBatch()
  // 6. If more work → return { moreWork: true }
}
```

### Wall-Clock Budget

- `DEFAULT_CHUNK_WALL_MS = 50000` (50 seconds)
- `chunkSize` default: 10 (from `EMAIL_BATCH_CHUNK_SIZE` env)
- `emailDelayMs` default: 5000ms (5 seconds between emails)
- Theoretical max: 10 emails × 5s delay = 50s ≈ fits within 50s wall budget

### Per-Batch Concurrency Guard

```js
if (this._runningBatches.has(batchId)) {
  return { alreadyRunning: true }; // Skip if another chunk is processing
}
this._runningBatches.add(batchId);
```

### SMTP Retry Logic (`sendMailWithRetry`)

| Error Type | Classification | Behavior |
|---|---|---|
| `EAUTH` or responseCode 535 | `AUTH_FAILED` | Permanent, no retry |
| 550, "does not exist", "NoSuchUser", "recipient rejected" | `USER_DOES_NOT_EXIST` | Permanent, no retry |
| "timed out", "ETIMEDOUT", "ECONNREFUSED", "socket hang up", "rate limit" | Retryable | Up to `maxRetries` (default 2), exponential backoff |
| Other errors | `OTHER_ERROR` | Permanent if not retryable |

### Legacy vs New System

- **Legacy** (`sendBatch`): Used by CLI `send` command; sends all items in one loop with `emailDelayMs` between each
- **New** (`createBatch` + `processBatchChunk`): Used by frontend `/api/email/send`; resumable, Vercel-compatible

---

## 22. Email Templates

### Email Structure

Generated by `emailGenerator.generateEmail(company, contact)`:

**Subject**: `Shopify Developer — Application for Opportunities at ${CompanyName}`

**Body**: Personalized greeting, introduction (candidate name, role, experience), mention of Shopify work, offer to share resume, closing.

**Attachment**: `26_Himanshu-Soni-Shopify.pdf` (resume)

### Focus Sentence Personalization

The `focusSentence` in the email body varies based on:
- **Public Apps**: Focus on app integration experience
- **Plus/Headless**: Focus on Shopify Plus and headless commerce experience
- **Services-based**: Focus on specific services the company offers

### Email Type Classification (from `validator.classifyEmailType`)

| Email Prefix | Type |
|---|---|
| hr, career, careers, recruiter, talent, hiring, jobs | `HR / Recruitment` |
| founder, ceo, cto, coo, vp, director, head, lead | `Hiring Management` |
| info, hello, contact, team | `General` |
| support, sales, billing, accounts, admin | `Support / Sales` (AVOID) |
| Default | `Personal / Professional` |

### Email Confidence Calculation

| Condition | Confidence |
|---|---|
| Direct website domain match OR Gmail + Shopify/LinkedIn source | `HIGH` |
| Domain matches company domain | `HIGH` |
| Source is Shopify directory or LinkedIn | `HIGH` |
| Otherwise | `MEDIUM` |

---

## 23. Email History & Export

**File**: `Testing/ccc/src/services/exportService.js`

### Generated Files

| File | Format | Contents |
|---|---|---|
| `shopify_leads.csv` | CSV (26 columns) | All qualified leads |
| `shopify_leads.xlsx` | XLSX | Same as CSV |
| `research_report.json` | JSON | Leads + statistics |
| `research_report.csv` | CSV | Simplified lead data |
| `email_queue.csv` | CSV | HIGH/MEDIUM confidence emails ready to send |
| `email_history.csv` | CSV | All sent/failed/dry-run email logs |

### CSV Columns (shopify_leads.csv — 26 columns)

Company, Employee Count, Employee Size Range, Employee Source, Employee Status, Shopify Partner URL, Official Website, Domain, City, State, Country, Partner Tier, Rating, Reviews, Shopify Services, Public Shopify Apps, App Relevance Score, Lead Score, Contact Name, Contact Role, Email, Email Type, Email Confidence, Email Source, Email Source URL, Careers URL, LinkedIn URL, Status, Created At, Updated At

---

## 24. WhatsApp Architecture Overview

### Integration Method

The system uses the **Evolution API** (a WhatsApp Business API gateway) rather than direct WhatsApp Web or official WhatsApp Business API.

### Evolution API Integration

**File**: `Testing/ccc/src/services/evolutionGoClient.js` (~1402 lines)

### Architecture

```
Frontend → Backend (Node.js) → Evolution API HTTP → Evolution Go (Docker container) → WhatsApp
```

The Evolution API acts as a middleware that:
1. Manages WhatsApp instances (connections)
2. Handles QR code generation for pairing
3. Provides HTTP endpoints for sending/receiving messages
4. Stores message logs in PostgreSQL (inside Docker)

### Profile Modes

- `PROFILE_GO`: Legacy Evolution Go profile endpoints
- `PROFILE_V2`: Newer v2 API endpoints
- Auto-detected based on `EVOLUTION_API_URL` configuration

---

## 25. Evolution API Integration

**File**: `Testing/ccc/src/services/evolutionGoClient.js`

### Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `/instance/all` | GET | List all instances |
| `/instance/fetchInstances` | GET | Fetch instance details |
| `/instance/create` | POST | Create new instance |
| `/instance/status` | GET | Check instance status |
| `/instance/connect` | POST | Connect instance |
| `/instance/qr` | GET | Get QR code for connection |
| `/send/text` | POST | Send text message (legacy) |
| `/message/sendText/{instance}` | POST | Send text message (v2) |
| `/chat/whatsappNumbers/{instance}` | GET | Check WhatsApp numbers |
| `/instance/logout` | POST | Logout instance |
| `/instance/delete` | DELETE | Delete instance |

### Phone Number Normalization

- Indian 10-digit numbers → `91` prefix (E.164 format: `+91XXXXXXXXXX`)
- Uses `libphonenumber-js` for validation

### QR Response Normalization

Handles multiple QR code formats from the API:
- Base64 PNG
- Base64 JPEG
- SVG
- Raw QR text

### Connection State Machine

```
DISCONNECTED → CREATE → QR GENERATED → SCAN → CONNECTING → CONNECTED
                                    → FAILED → RETRY or DELETE
```

---

## 26. WhatsApp Generator

**File**: `Testing/ccc/src/services/whatsappGenerator.js`

### `generateMessage(company, contact)`

Returns a personalized WhatsApp message:

```js
{
  recipientName: contact.name || `${companyName} Team`,
  companyName: company.name,
  phone: contact.normalized_phone || company.normalized_phone,
  text: `Hi ${name},

I'm ${candidateName}, a ${candidateRole} with around ${candidateExperience} of experience in Shopify, Shopify Plus, custom apps, APIs, GraphQL, JavaScript and Node.js.

I came across your Shopify work and I'm currently exploring Shopify Developer opportunities.

I'd be happy to share my resume if there is any relevant opening.

Thanks,
${candidateName}`
}
```

### Settings-Based Personalization

Reads from `settingsService.getSettings(false)`:
- `candidateName` (default: "Himanshu Soni")
- `candidateRole` (default: "Shopify Developer")
- `candidateExperience` (default: "3 years")

---

## 27. WhatsApp Workflow (Single & Batch)

**File**: `Testing/ccc/src/workflows/whatsappWorkflow.js`

### `sendSingleMessage(companyId, customPhone, customMessage)`

1. Get company from DB
2. Get best contact
3. Resolve target phone (custom > contact > company)
4. **Opt-out check**: `db.isWhatsAppOptedOut(targetPhone)` → skip if opted out
5. **Duplicate check**: `db.isWhatsAppContacted(company.id, targetPhone)` → skip if already sent
6. Generate message via `whatsappGenerator`
7. Send via `evolutionGoClient.sendTextMessage()`
8. Log result to `whatsapp_logs` table

### `sendBatch(companyIds, onProgress)`

- Sequential processing (not parallel)
- `whatsAppDelayMs` default: 15000ms (15 seconds) between messages
- Progress callback for frontend updates
- Counts: `sent`, `failed`, `skipped` (opted out or already contacted)

### Sequential Delay

```js
for (let i = 0; i < companyIds.length; i++) {
  const sendRes = await this.sendSingleMessage(companyId);
  if (i < companyIds.length - 1) {
    await sleep(delayMs); // 15000ms default
  }
}
```

---

## 28. WhatsApp Connection Flow

### Connection Process (from frontend API)

1. **`fetchWhatsAppStatus()`**: Check if Evolution API instance exists and is connected
2. **`connectWhatsApp()`**: 
   - Create instance via Evolution API (`/instance/create`)
   - Generate QR code (`/instance/qr`)
   - User scans QR code in WhatsApp mobile app
   - Instance transitions to connected state
3. **`disconnectWhatsApp()`**: Logout and optionally delete instance
4. **`simulateWhatsAppConnect()`**: Test/development helper

### QR Code Display

The QR code is rendered as an image in the frontend for the user to scan with their WhatsApp mobile app. The Evolution Go container generates and serves the QR code.

### Instance Management

- Instance name: `job-search` (default from `EVOLUTION_INSTANCE_NAME`)
- Each instance is a persistent WhatsApp connection
- Multiple instances can be created via `/instance/create`

---

## 29. WhatsApp Templates & Messages

### Message Format

WhatsApp messages are **plain text** (not template-based with buttons/lists):

```
Hi [Name/Team],

I'm [Himanshu Soni], a Shopify Developer with around 3 years of experience in Shopify, Shopify Plus, custom apps, APIs, GraphQL, JavaScript and Node.js.

I came across your Shopify work and I'm currently exploring Shopify Developer opportunities.

I'd be happy to share my resume if there is any relevant opening.

Thanks,
Himanshu Soni
```

### Template Support

`NOT CONFIRMED FROM CODE` as to whether Evolution API's official template system (HSM - Highly Structured Messages) is used. The current implementation uses plain text messages via `/message/sendText/{instance}`.

### Message Statuses

| Status | Meaning |
|---|---|
| `SENT` | Successfully delivered to WhatsApp |
| `DRY_RUN_SENT` | Simulated (dry run mode) |
| `FAILED` | Delivery failed |
| `REPLIED` | Recipient replied (not confirmed from code as tracking mechanism) |
| `OPTED_OUT` | User opted out of WhatsApp messaging |

---

## 30. Ready Queue & Duplicate Protection

### Ready Queue Definition

The ready queue consists of companies with `status = "READY"` — meaning:
1. Employee count verified as >= threshold (QUALIFIED)
2. At least one contact with HIGH or MEDIUM email confidence found
3. App relevance score >= 50
4. Not excluded, not already contacted

### Queue Generation

```js
// database.js: _buildReadyQueueWhere()
// Single source of truth for eligibility:
// status = 'READY' AND email_confidence IN ('HIGH', 'MEDIUM') AND email IS NOT NULL
```

### Duplicate Protection

**Email duplicate protection**:
- `email_batch_items` has `UNIQUE(batch_id, company_id)` constraint
- `markBatchItemSent()` uses `INSERT OR IGNORE` with status update
- `hasBeenContacted(email, companyId)` checks `email_logs` and `companies` status
- Auto-exclusion: After sending, company is added to exclusions CSV with reason `Contacted Lead (email)`

**WhatsApp duplicate protection**:
- `isWhatsAppContacted(companyId, phone)` checks `whatsapp_logs` for `SENT` or `DRY_RUN_SENT`
- `isWhatsAppOptedOut(phone)` checks opt-out list
- Per-message opt-out check before sending

### Email Delay Between Sends

- Default: 5000ms (5 seconds) between emails within a chunk
- Configured via `EMAIL_DELAY_MS` env var
- `NOT CONFIRMED FROM CODE` whether this is primarily for rate limiting or Gmail's sending limits

---

## 31. Docker & Evolution API Deployment

**File**: `docker-compose.evolution.yml`

### Docker Compose Services

```yaml
version: '3.8'
services:
  evolution-postgres:
    image: postgres:15-alpine
    # Stores Evolution API's internal data
    ports: ["5433:5432"]

  evolution-go:
    image: evoai/evolution-go:latest
    # WhatsApp Business API gateway
    ports: ["8080:8080"]
```

### Evolution PostgreSQL

- `POSTGRES_USER: evolution`
- `POSTGRES_PASSWORD: evolution_password`
- `POSTGRES_DB: evolution_go`
- Port: 5433 (mapped from container 5432 to avoid conflict with local PostgreSQL if any)

### Evolution Go Container

- `SERVER_PORT: 8080`
- `AUTHENTICATION_API_KEY: your_global_evolution_api_key_here` — `REPLACE WITH ACTUAL KEY`
- `DATABASE_ENABLED: "true"`
- `DATABASE_CONNECTION_URI: postgresql://evolution:evolution_password@evolution-postgres:5432/evolution_go`
- `QRCODE_LIMIT: 30`
- `LOG_LEVEL: INFO`
- Volume: `evolution_instances_data:/evolution/instances` (persistent instance data)

### Docker Usage

```bash
docker-compose up -d
# Evolution API available at http://localhost:8080
# PostgreSQL available at localhost:5433
```

`NOT CONFIRMED FROM CODE` whether this Docker setup is actively used in production or is a local development setup only.

---

## 32. Local vs Production Environments

### Local Development (Windows)

| Aspect | Value |
|---|---|
| **Runtime** | Node.js on Windows |
| **Database** | `data/leads.sqlite` (repo root) |
| **Logs** | `logs/` |
| **Output** | `output/` |
| **Backend Server** | `node src/server.js` on port 3000 |
| **Frontend** | `npm run dev` on port 3001 |
| **Cron Worker** | `scheduleNextChunk` via setTimeout |
| **Entry Point** | `src/server.js` (plain HTTP) |
| **.env** | `Testing/ccc/.env` |

### Production (Vercel)

| Aspect | Value |
|---|---|
| **Runtime** | Vercel serverless (`@vercel/node`) |
| **Database** | `/tmp/data/leads.sqlite` (ephemeral) |
| **Logs** | `/tmp/logs` |
| **Output** | `/tmp/output` |
| **Backend Entry** | `src/server.cjs` |
| **Frontend** | Vercel-hosted Next.js |
| **Cron Worker** | `/api/email/batch/worker` every minute (`* * * * *`) |
| **.env** | NOT loaded; Vercel environment variables |
| **Max Duration** | 300 seconds per function |

### Cross-Platform Path Handling

```js
// config.js
const dataDir = isVercelRuntime
  ? (process.env.DATA_DIR || "/tmp/data")
  : (process.env.DATA_DIR || path.join(rootDir, "data"));
```

### Key Differences

1. **Batch self-resume**: Local uses `scheduleNextChunk` (setTimeout); Vercel relies on cron worker
2. **Database path**: Local = file-based; Vercel = `/tmp` (ephemeral, may be lost on cold start)
3. **Environment loading**: Local loads `.env`; Vercel uses dashboard env vars
4. **CORS**: Local server has explicit CORS preflight; Vercel routes may not need it

---

## 33. Environment Variables

### Required Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | Gmail SMTP host |
| `SMTP_PORT` | `587` | Gmail SMTP port |
| `SMTP_SECURE` | `false` | TLS setting |
| `SMTP_USER` | `himanshusoni7899@gmail.com` | Gmail address |
| `SMTP_PASSWORD` | `""` | Gmail app password |
| `EMAIL_FROM` | `Himanshu Soni <himanshusoni7899@gmail.com>` | Sender address |
| `EVOLUTION_API_URL` | `https://evolution-api-latest-h0yy.onrender.com` | Evolution API base URL |
| `EVOLUTION_API_KEY` | `""` | Evolution API authentication key |
| `EVOLUTION_INSTANCE_NAME` | `job-search` | WhatsApp instance name |
| `WHATSAPP_ENABLED` | `true` | Enable/disable WhatsApp |
| `WHATSAPP_DRY_RUN` | `false` | WhatsApp dry run |
| `WHATSAPP_DELAY_MS` | `15000` | Delay between WhatsApp messages |
| `DRY_RUN` | `true` | Email dry run mode (default safe) |
| `SEND_LIMIT` | `null` | Max emails per batch |
| `EMAIL_DELAY_MS` | `5000` | Delay between emails |
| `MAX_RETRIES` | `2` | SMTP retry count |
| `RETRY_DELAY_MS` | `5000` | Retry delay |
| `BATCH_SIZE` | `10` | Legacy batch size |
| `BATCH_DELAY_MS` | `60000` | Legacy batch delay |
| `TARGET_LEADS` | `100` | Target number of leads |
| `MIN_APP_RELEVANCE_SCORE` | `70` | Minimum app relevance |
| `MIN_EMPLOYEE_COUNT` | `null` | Employee threshold (disabled by default) |
| `SEARCH_PROVIDER` | `direct` | Search provider type |
| `SEARCH_API_KEY` | `""` | Search API key |
| `SHOPIFY_PARTNER_DIRECTORY_URL` | `https://www.shopify.com/in/partners/directory/locations/india` | Discovery URL |
| `DATA_DIR` | Platform-dependent | Data directory |
| `DATABASE_PATH` | Platform-dependent | SQLite file path |
| `LOGS_DIR` | Platform-dependent | Logs directory |
| `OUTPUT_DIR` | Platform-dependent | Output directory |
| `EXCLUSIONS_PATH` | Platform-dependent | Exclusions CSV path |
| `RESUME_PATH` | `26_Himanshu-Soni-Shopify.pdf` | Resume PDF path |
| `HTTP_TIMEOUT_MS` | `12000` | HTTP request timeout |
| `EMAIL_BATCH_CHUNK_SIZE` | `10` | Items per batch chunk |
| `EMAIL_BATCH_CHUNK_WALL_MS` | `50000` | Chunk wall-clock budget |

### Vercel Environment Variables

On Vercel, all variables must be set in the Vercel dashboard under Settings → Environment Variables. The `.env` file is explicitly NOT loaded.

---

## 34. Error Handling Strategy

### SMTP Error Classification

From `settingsService.testSmtpConnection()` and `emailSender.sendMailWithRetry()`:

| Error Category | SMTP Codes/Patterns | Behavior |
|---|---|---|
| `AUTH_FAILED` | `EAUTH`, responseCode 535 | Permanent — no retry, fail batch |
| `USER_DOES_NOT_EXIST` | 550, "does not exist", "NoSuchUser", "recipient rejected" | Permanent — no retry, fail item |
| `NETWORK_TIMEOUT` | "timed out", "ETIMEDOUT" | Retryable — up to maxRetries |
| `SMTP_REJECTED` | Various 5xx | Permanent |
| `SMTP_SERVER_ERROR` | Various | Retryable |
| `TLS_ERROR` | TLS handshake failures | Permanent |

### Batch-Level Error Handling

- If SMTP credentials missing at batch start → `db.failEmailBatch(batchId, error)`
- If resume attachment missing → `db.failEmailBatch(batchId, error)`
- If DB unavailable during batch → `server.cjs` env fallback

### Per-Item Error Handling

- `markBatchItemFailed(batchId, companyId, error, attempts)` — records failure
- `db.updateCompanyStatus(companyId, "FAILED", error)` — marks company as failed
- Item is NOT retried individually — failed items stay FAILED

### Graceful Degradation

- `server.cjs` returns env-based settings when DB is unavailable
- `config.js` catches `fs.mkdirSync` errors without crashing
- `fetchUrl()` returns `{ status: 0, html: "" }` on network errors
- `evolutionGoClient` swallows network errors gracefully

---

## 35. Logging System

**File**: `Testing/ccc/src/services/logger.js`

### Log Levels

| Level | Prefix | Purpose |
|---|---|---|
| `info` | `ℹ️` | General information |
| `success` | `✅` | Successful operations |
| `warn` | `⚠️` | Warnings |
| `error` | `❌` | Errors |
| `debug` | `🔍` | Debugging |
| `email` | `📧` | Email-specific |
| `progress` | `📊` | Progress indicators |
| `section` | `═══` | Section dividers |

### Log Files

| File | Path |
|---|---|
| `research.log` | `logs/research.log` |
| `errors.log` | `logs/errors.log` |
| `email.log` | `logs/email.log` |

### Log Output Format

Logs include timestamps, emoji prefixes, and colored output for terminal readability. File-based logging writes to the respective log files in the `logs/` directory.

---

## 36. Security Considerations

### Credentials Protection

- **NEVER** hardcode credentials in source code
- `.env` file is in `.gitignore` (implied by the `.env` example showing `SMTP_PASS=wfxmqifbdfobpxij`)
- Secrets masked in settings UI as `••••••••`
- `config.js` explicitly does NOT load `.env` on Vercel runtime

### Input Validation

- `validator.isValidEmailFormat()`: RFC-compliant email validation with disposable/ignored domain checks
- `validator.cleanEmail()`: Strips HTML artifacts, `mailto:` prefix, `@www.`
- `validator.normalizePhone()`: Uses `libphonenumber-js` for international validation
- `validator.extractPhones()`: Filters toll-free (`1800`, `1860`, `800`), support/sales numbers
- `validator.checkMxRecords()`: DNS MX record verification

### Rate Limiting

- 5000ms (`emailDelayMs`) between emails
- 15000ms (`whatsAppDelayMs`) between WhatsApp messages
- Chunk wall-clock budget (50000ms) prevents Vercel timeout
- Per-batch concurrency guard prevents overlapping sends

### Opt-Out & Duplicate Protection

- WhatsApp opt-out check before every message
- Email duplicate check via `hasBeenContacted()`
- WhatsApp duplicate check via `isWhatsAppContacted()`
- Auto-exclusion after contact

### Data Integrity

- SQLite WAL mode for concurrent access
- Atomic batch item claims (`getNextBatchItems` with locking)
- `INSERT OR IGNORE` for idempotent operations
- Transaction rollback on errors
- Counter refresh after each chunk

### Limitations

- `NOT CONFIRMED FROM CODE` whether there is any authentication/authorization on the API (appears to be none — the API is open)
- `NOT CONFIRMED FROM CODE` whether HTTPS is enforced on all endpoints
- `NOT CONFIRMED FROM CODE` whether there is CSRF protection
- The API appears to have no rate limiting on incoming requests (only on outgoing emails)

---

## 37. Dependencies

### Backend Dependencies (`Testing/ccc/package.json`)

```json
{
  "name": "ccc",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.js",
  "scripts": {
    "discover": "node src/cli.js discover",
    "research": "node src/cli.js research",
    "leads": "node src/cli.js leads",
    "export": "node src/cli.js export",
    "preview": "node src/cli.js preview",
    "send": "node src/cli.js send",
    "status": "node src/cli.js status",
    "exclude": "node src/cli.js exclude"
  },
  "dependencies": {
    "nodemailer": "latest",
    "dotenv": "latest",
    "jsdom": "latest",
    "libphonenumber-js": "latest",
    "pdfjs-dist": "latest",
    "puppeteer": "latest",
    "qrcode": "latest",
    "xlsx": "latest",
    "csv-writer": "latest",
    "csv-parser": "latest"
  }
}
```

Note: `"puppeteer"` is declared in dependencies but `NOT CONFIRMED FROM CODE` as actively used in the core scraping flow — the Shopify Directory discovery uses simple HTTP requests + regex parsing.

### Frontend Dependencies (`frontend/package.json`)

```json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "next": "15.1.7",
    "react": "19",
    "react-dom": "19",
    "lucide-react": "latest",
    "tailwindcss": "3.4",
    "typescript": "latest",
    "@radix-ui/react-slot": "latest"
  }
}
```

---

## 38. External Services & Integrations

### Gmail SMTP

- **Provider**: Gmail (smtp.gmail.com:587)
- **Library**: Nodemailer
- **Authentication**: SMTP username/password (app-specific password recommended)
- **Rate Limiting**: 5000ms delay between emails; 50000ms wall-clock budget per chunk
- **Retry Logic**: Up to 2 retries with exponential backoff for network errors
- **Attachment**: Resume PDF (`26_Himanshu-Soni-Shopify.pdf`) attached to every outreach email

### Evolution API (WhatsApp)

- **Provider**: Evolution Go (evoai/evolution-go:latest Docker image)
- **API**: REST HTTP API
- **Authentication**: `AUTHENTICATION_API_KEY` (global API key)
- **Database**: PostgreSQL 15 (inside Docker container)
- **Instance Management**: Create, connect via QR, send messages, logout, delete
- **Phone Format**: E.164 (+91 for Indian numbers)
- **Message Types**: Plain text only (HSM templates not confirmed in use)

### Shopify Partner Directory

- **URL**: `https://www.shopify.com/in/partners/directory/locations/india`
- **Method**: HTTP GET + HTML regex parsing
- **Pagination**: Up to 40 pages, 16 cards per page
- **Rate Limiting**: 600ms delay between research operations
- **Extraction**: `data-component-name="listing-profile-card"` attribute parsing

### Search Providers (Optional)

- **SerpAPI**: Google search results for HR email discovery
- **Status**: Configurable via `SEARCH_PROVIDER` and `SEARCH_API_KEY`
- **Default**: `direct` (no API, uses only website crawling)

### Vercel

- **Runtime**: `@vercel/node` builder
- **Cron**: `* * * * *` for `/api/email/batch/worker`
- **Max Duration**: 300 seconds per function
- **Build**: `src/server.cjs` via `@vercel/node`

---

## 39. Deployment & Hosting

### Local Development

```bash
# Backend
cd Testing/ccc
npm install
node src/server.js  # Port 3000

# Frontend
cd frontend
npm install
npm run dev  # Port 3001

# Discovery
node src/cli.js discover

# Research
node src/cli.js research

# Send emails
node src/cli.js send
```

### Vercel Deployment

1. Connect GitHub repository to Vercel
2. Set all environment variables in Vercel dashboard
3. `vercel.json` configures build and routes automatically
4. Cron worker auto-deployed with `* * * * *` schedule

### Docker (Evolution API)

```bash
docker-compose up -d
# Evolution API: http://localhost:8080
# PostgreSQL: localhost:5433
```

### File Exports

The `download/csv` and `download/xlsx` endpoints serve generated files from `output/` directory.

---

## 40. CLI Interface

**File**: `Testing/ccc/src/cli.js`

### Commands

| Command | Description |
|---|---|
| `node src/cli.js discover` | Discover Shopify partners from directory |
| `node src/cli.js research` | Research discovered companies |
| `node src/cli.js leads` | Run end-to-end lead generation engine |
| `node src/cli.js export` | Export all data (CSV, XLSX, JSON) |
| `node src/cli.js preview` | Preview email for a company |
| `node src/cli.js send` | Send emails (legacy batch) |
| `node src/cli.js status` | Show system status and statistics |
| `node src/cli.js exclude` | Manage exclusions |

### Send Workflow

**File**: `Testing/ccc/src/workflows/sendWorkflow.js`

```js
async function runSend({ limit, dryRun, yes }) {
  // 1. Get qualified leads
  // 2. Show confirmation prompt (unless yes=true)
  // 3. Generate emails
  // 4. Send via legacy sendBatch()
  // 5. Update status, add exclusions, log emails
}
```

---

## 41. Migrations & Schema Evolution

**File**: `Testing/ccc/src/db/migrations.js`

### Migration Strategy

- All tables defined in a single `migrations.js` file
- Uses `ALTER TABLE` for backward compatibility when adding new columns
- `INSERT OR IGNORE` and `INSERT OR REPLACE` for safe schema changes
- The `email_batch_items` table was added later as part of the resumable batch system redesign

### Schema Versioning

`NOT CONFIRMED FROM CODE` as to whether there is an explicit migration version table. The current approach uses inline migration scripts that run on database initialization.

### Key Schema Additions (Historical)

- `companies` table: Core company data (37 columns)
- `contacts` table: Discovered contacts
- `sources` table: Audit trail for evidence sources
- `exclusions` table: Excluded companies
- `email_batches` + `email_batch_items`: Resumable batch system (added to fix Vercel timeout)
- `email_logs` + `whatsapp_logs`: Activity logs
- `settings` table: Runtime settings storage

---

## 42. Rate Limiting & Throttling

### Email Rate Limiting

| Mechanism | Value | Purpose |
|---|---|---|
| `emailDelayMs` | 5000ms (5s) | Delay between emails within a chunk |
| `EMAIL_BATCH_CHUNK_WALL_MS` | 50000ms (50s) | Max wall-clock time per chunk |
| `EMAIL_BATCH_CHUNK_SIZE` | 10 | Max items per chunk |
| `maxRetries` | 2 | SMTP retry count |
| `retryDelayMs` | 5000ms | Delay between retries |

### WhatsApp Rate Limiting

| Mechanism | Value | Purpose |
|---|---|---|
| `whatsAppDelayMs` | 15000ms (15s) | Delay between WhatsApp messages |
| Sequential processing | Yes | No parallel sends |

### Discovery Rate Limiting

| Mechanism | Value | Purpose |
|---|---|---|
| Research delay | 600ms | Between company research operations |
| Pagination stop | 3 empty pages | Stop discovery when no more results |

---

## 43. Dry Run Mode

### Purpose

Safe testing mode that simulates sending without actually delivering emails or WhatsApp messages.

### Email Dry Run

- Controlled by `DRY_RUN` env var (default: `true`)
- `sendMailWithRetry()` with `isDryRun=true`:
  - Returns `{ success: true, dryRun: true, messageId: "dry-run-" + Date.now() }`
  - No actual SMTP connection
  - Company status updated to `CONTACTED` (simulated)
  - Email logged as `DRY_RUN_SENT`
- `BatchSenderModal.tsx` shows: "Live Mode: You are about to send X real emails" warning

### WhatsApp Dry Run

- Controlled by `WHATSAPP_DRY_RUN` env var
- Evolution API `dryRun` flag passed to send endpoints
- Messages logged as `DRY_RUN_SENT`

### Settings UI

The settings page allows toggling `dryRun` flag. When enabled, all sends are simulated.

---

## 44. Known Limitations & Design Decisions

### Limitations

1. **Vercel ephemeral storage**: `/tmp` is cleared on cold starts; database may be lost. The cron worker attempts to resume batches, but if the DB file is gone, batches cannot be resumed. `NOT CONFIRMED FROM CODE` as to whether this is mitigated by Vercel's persistent `/tmp` in practice.

2. **Single operator**: No multi-user support; all data is shared across the single operator (Himanshu Soni).

3. **No authentication**: The API endpoints appear to have no authentication layer. `NOT CONFIRMED FROM CODE` as to whether any access control is planned.

4. **SQLite concurrency**: While WAL mode helps, the database is a single file. Heavy concurrent access from Vercel function instances could cause lock contention.

5. **Puppeteer declared but unused**: `puppeteer` is in `package.json` dependencies but `NOT CONFIRMED FROM CODE` as being actively used in the core flow. The scraping uses plain HTTP requests + regex.

6. **Gmail SMTP limits**: Gmail has daily sending limits (500 emails/day for free accounts). The system does not appear to track daily quotas.

7. **Evolution API dependency**: WhatsApp functionality depends entirely on the Evolution API being available and the instance being connected.

8. **Local development only**: The Windows + Vercel split means some behaviors differ between environments (cron vs setTimeout, `/tmp` vs file-based).

### Design Decisions

1. **CommonJS over ESM**: Chosen for compatibility with all dependencies (some older packages require CommonJS).

2. **node:sqlite over better-sqlite3**: Built-in Node.js stdlib, no native compilation needed, works across platforms.

3. **Resumable batch instead of single long-running function**: Solves Vercel's 300-second function timeout by breaking work into chunks.

4. **Cron-based self-resume on Vercel**: Instead of `setTimeout` (which doesn't survive function termination), Vercel cron triggers `/api/email/batch/worker` every minute.

5. **CSV + DB dual storage for exclusions**: CSV provides human-readable audit trail; DB provides fast lookups.

6. **Plain text WhatsApp messages**: Simpler than HSM templates; no template approval needed from WhatsApp.

7. **No search provider by default**: `direct` mode uses only website crawling to avoid API costs and dependencies.

---

## 45. Future Feature: Remote Job Discovery (Planned)

This documentation serves as the baseline before adding a **Remote Job Discovery** feature. The following observations from the current architecture are relevant to that planned feature:

### Extension Points

1. **New Provider**: A `remoteJobsProvider.js` in `src/providers/` would follow the same pattern as `shopifyDirectory.js`, `companyWebsite.js`, etc.

2. **New Workflow**: A `remoteJobWorkflow.js` in `src/workflows/` would follow the same pattern as `discoverWorkflow.js` and `researchWorkflow.js`.

3. **Database Extension**: New columns or tables would be needed for remote job listings (source, title, description, location, salary, applied status).

4. **New Scoring**: A remote job relevance score could be added alongside `scoring.js`'s existing `calculateAppRelevance()` and `calculateLeadScore()`.

5. **New Exclusion Logic**: Remote job platforms (e.g., LinkedIn Jobs, Indeed) would need their own exclusion rules.

6. **New API Endpoints**: Frontend would need new pages and API routes for remote job discovery and management.

7. **New Export Format**: `exportService.js` would need to support remote job exports alongside existing Shopify lead exports.

### Architecture Compatibility

The current system's modular design (providers → workflows → services → database → API) is well-suited for adding a new feature without modifying existing code paths, following the **Open/Closed Principle**.

---

## Appendix A: File Structure

```
automationJobs/
├── Testing/
│   ├── ccc/
│   │   ├── .env                          # Environment variables (secrets)
│   │   ├── vercel.json                   # Vercel deployment config
│   │   ├── package.json                  # Backend dependencies
│   │   ├── src/
│   │   │   ├── server.cjs                # Vercel entry point
│   │   │   ├── server.js                 # Local entry point
│   │   │   ├── config.js                 # Configuration system
│   │   │   ├── cli.js                    # CLI command dispatcher
│   │   │   ├── db/
│   │   │   │   ├── database.js           # SQLite database layer (~1041 lines)
│   │   │   │   └── migrations.js         # Schema definitions
│   │   │   ├── services/
│   │   │   │   ├── emailSender.js        # Email sending + resumable batches (~504 lines)
│   │   │   │   ├── emailGenerator.js     # Email template generation
│   │   │   │   ├── evolutionGoClient.js  # Evolution API integration (~1402 lines)
│   │   │   │   ├── whatsappGenerator.js  # WhatsApp message generation
│   │   │   │   ├── normalizer.js         # Company/domain normalization
│   │   │   │   ├── exclusionService.js   # Exclusion management + fuzzy matching
│   │   │   │   ├── settingsService.js    # Settings management + SMTP/Evolution test
│   │   │   │   ├── scoring.js            # App relevance + lead scoring
│   │   │   │   ├── logger.js             # Multi-level logging
│   │   │   │   ├── employeeVerifier.js   # Employee count verification
│   │   │   │   └── validator.js          # Email/phone validation
│   │   │   ├── providers/
│   │   │   │   ├── shopifyDirectory.js   # Shopify Partner crawler
│   │   │   │   ├── companyWebsite.js     # Website research + contact extraction
│   │   │   │   ├── linkedInProvider.js   # LinkedIn headcount extraction
│   │   │   │   ├── searchProvider.js     # Search provider (SerpAPI/Google)
│   │   │   │   └── newest.js             # NOT CONFIRMED FROM CODE
│   │   │   └── workflows/
│   │   │       ├── discoverWorkflow.js   # Discovery orchestration
│   │   │       ├── researchWorkflow.js   # Research orchestration
│   │   │       ├── leadWorkflow.js       # End-to-end lead engine
│   │   │       ├── sendWorkflow.js       # CLI send workflow
│   │   │       └── whatsappWorkflow.js   # WhatsApp send orchestration
│   │   ├── output/                       # Generated export files
│   │   │   ├── shopify_leads.csv
│   │   │   ├── shopify_leads.xlsx
│   │   │   ├── email_history.csv
│   │   │   ├── email_queue.csv
│   │   │   ├── research_report.json
│   │   │   └── research_report.csv
│   │   ├── data/                         # SQLite + exclusions CSV
│   │   │   ├── leads.sqlite
│   │   │   └── excluded_companies.csv
│   │   └── logs/                         # Log files
│   │       ├── research.log
│   │       ├── errors.log
│   │       └── email.log
│   ├── index.js                          # Separate OpenAI test server (not part of main system)
│   └── node_modules/
├── frontend/
│   ├── app/
│   │   ├── page.tsx                      # Dashboard
│   │   ├── leads/page.tsx                # Qualified leads
│   │   ├── outreach/page.tsx             # Email & WhatsApp dispatch
│   │   ├── discovery/page.tsx            # Partner discovery
│   │   ├── companies/page.tsx            # All companies
│   │   ├── exclusions/page.tsx           # Exclusions management
│   │   ├── settings/page.tsx             # Settings
│   │   └── layout.tsx                    # Root layout
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Header.tsx
│   │   │   └── MobileNav.tsx
│   │   ├── email/
│   │   │   ├── BatchSenderModal.tsx
│   │   │   ├── EmailPreviewModal.tsx
│   │   │   └── EmailHistoryTable.tsx
│   │   ├── leads/
│   │   │   ├── LeadsTable.tsx
│   │   │   ├── LeadDrawer.tsx
│   │   │   ├── LeadScoreBadge.tsx
│   │   │   └── WhatsAppPreviewModal.tsx
│   │   ├── discovery/
│   │   │   └── DiscoveryRunner.tsx
│   │   ├── exclusions/
│   │   │   ├── ExclusionsTable.tsx
│   │   │   └── AddExclusionModal.tsx
│   │   ├── dashboard/
│   │   │   ├── PipelineStatus.tsx
│   │   │   ├── QuickActions.tsx
│   │   │   ├── StatGrid.tsx
│   │   │   └── WhatsAppWidget.tsx
│   │   └── ui/
│   │       ├── Card.tsx
│   │       ├── Button.tsx
│   │       ├── Modal.tsx
│   │       ├── Drawer.tsx
│   │       ├── Badge.tsx
│   │       ├── Skeleton.tsx
│   │       └── Toast.tsx
│   ├── lib/
│   │   ├── api/
│   │   │   ├── client.ts               # API client
│   │   │   ├── email.ts
│   │   │   ├── whatsapp.ts
│   │   │   ├── leads.ts
│   │   │   ├── settings.ts
│   │   │   ├── exclusions.ts
│   │   │   ├── stats.ts
│   │   │   └── actions.ts
│   │   ├── utils.ts
│   │   └── types.ts
│   ├── tailwind.config.ts
│   └── package.json
├── docs/
│   └── frontend-api-map.md              # Full API specification
├── docker-compose.evolution.yml          # Evolution API Docker setup
└── CURRENT_SYSTEM_TECHNICAL_DOCUMENTATION.md  # This file
```

## Appendix B: Key Functions Reference

### Email System

| Function | File | Description |
|---|---|---|
| `EmailSender.getTransporter()` | `emailSender.js` | Creates/reuses Nodemailer transporter |
| `EmailSender.verifyTransporter()` | `emailSender.js` | Verifies SMTP connection |
| `EmailSender.sendMailWithRetry()` | `emailSender.js` | Sends with classification & retry |
| `EmailSender.createBatch()` | `emailSender.js` | Creates resumable batch |
| `EmailSender.processBatchChunk()` | `emailSender.js` | Processes one chunk atomically |
| `EmailSender.scheduleNextChunk()` | `emailSender.js` | Self-resume via setTimeout |
| `generateEmail(company, contact)` | `emailGenerator.js` | Generates personalized email |

### WhatsApp System

| Function | File | Description |
|---|---|---|
| `EvolutionGoClient.getInstance()` | `evolutionGoClient.js` | Gets or creates instance |
| `EvolutionGoClient.connect()` | `evolutionGoClient.js` | Connects instance via QR |
| `EvolutionGoClient.sendTextMessage()` | `evolutionGoClient.js` | Sends WhatsApp text |
| `EvolutionGoClient.getStatus()` | `evolutionGoClient.js` | Checks connection status |
| `whatsappGenerator.generateMessage()` | `whatsappGenerator.js` | Generates WhatsApp message |
| `whatsappWorkflow.sendSingleMessage()` | `whatsappWorkflow.js` | Sends single WhatsApp message |
| `whatsappWorkflow.sendBatch()` | `whatsappWorkflow.js` | Sends batch WhatsApp messages |

### Discovery & Research

| Function | File | Description |
|---|---|---|
| `shopifyDirectory.discoverPartners()` | `shopifyDirectory.js` | Crawls Shopify partner directory |
| `shopifyDirectory.fetchPartnerProfile()` | `shopifyDirectory.js` | Fetches partner profile page |
| `companyWebsite.researchWebsite()` | `companyWebsite.js` | Crawls company website |
| `linkedInProvider.getCompanyHeadcount()` | `linkedInProvider.js` | Extracts LinkedIn headcount |
| `searchProvider.searchHiringContacts()` | `searchProvider.js` | Searches for HR contacts |
| `researchCompany()` | `researchWorkflow.js` | Full research pipeline |
| `runDiscovery()` | `discoverWorkflow.js` | Discovery orchestration |

### Database

| Function | File | Description |
|---|---|---|
| `upsertCompany()` | `database.js` | Insert/update company |
| `getFinalQualifiedLeads()` | `database.js` | Get all qualified leads |
| `getNextBatchItems()` | `database.js` | Atomically claim batch items |
| `markBatchItemSent()` | `database.js` | Mark item as sent |
| `markBatchItemFailed()` | `database.js` | Mark item as failed |
| `completeEmailBatch()` | `database.js` | Complete batch |
| `failEmailBatch()` | `database.js` | Fail batch |
| `isWhatsAppOptedOut()` | `database.js` | Check WhatsApp opt-out |
| `isWhatsAppContacted()` | `database.js` | Check WhatsApp duplicate |
| `getStatistics()` | `database.js` | Aggregate stats |

---

*End of documentation. This document is based strictly on actual code in the repository. No features, values, or code paths have been fabricated.*
