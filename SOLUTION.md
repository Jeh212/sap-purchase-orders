# SOLUTION.md — Challenge 03: SAP Purchase Orders Conversational Agent

## 1. The problem in one sentence

Administrative analysts at Periferia manually key purchase-order data from email packages into SAP, introducing errors and bypassing controls that currently exist only as institutional memory.

**Who it hurts:** the analyst (repetitive, error-prone entry), accounting (catches mistyped cost centers at close), and management (no measurement of retroactive POs created after invoices arrive).

---

## 2. Architecture

```
Browser (React + Vite)
  │  POST /api/chat { sessionId, message, confirm }
  │  GET  /api/sessions/:id
  ▼
Fastify (src/server.ts)
  │  Agent loop: user → model → tool calls → model → reply
  │  Session memory (in-process Map)
  │  Confirmation state machine (InMemoryConfirmationStore)
  ▼
LLM adapter (src/llm/adapter.ts interface)
  ├── src/llm/anthropic.ts  (Anthropic Messages API)
  └── src/llm/openai.ts     (OpenAI Chat Completions API)
  ▼
Tools (src/tools/po.ts) — deterministic, no LLM involvement
  │  Domain logic (src/domain/)
  │    ├── normalize.ts   — package parsing / quote extraction
  │    ├── rules.ts       — RC1–RC10 pure functions
  │    ├── payload.ts     — PurchaseOrder builder
  │    ├── schemas.ts     — Zod types
  │    └── confirmation.ts — TTL-bounded confirmation store
  │  Fixtures (read-only)
  └── SAP mock (src/sap/mock.ts) → out/sap/orders.jsonl
      out/<case>/approval.txt
      out/<case>/traceability.json
      out/control.csv
      out/log.jsonl
```

**Separation of concerns:**
- `agent/prompt.md` — agent behavior policy; no business logic embedded here
- `src/knowledge/purchase-orders.md` — process semantics for the model to reference
- `src/tools/po.ts` — all execution; the model is only a dispatcher
- `src/domain/` — pure business rules; testable without HTTP or LLM

---

## 3. Agent loop

The loop in `runAgentTurn` (`src/server.ts`):

1. Before each model call, check the remaining session token budget.
2. Send the full conversation history plus the five tool definitions to the model.
3. If the model returns tool calls, validate arguments with Zod, execute, and append results.
4. Tool-call IDs are cached so a repeated ID is never double-executed.
5. If the model returns content without tool calls, the turn ends.
6. **Iteration cap:** configurable via `MAX_ITERATIONS` (default 25). On expiry the agent replies with a summary of completed calls.
7. **Human confirmation:** the agent ends the turn with a question; `po_create` internally checks `InMemoryConfirmationStore` for a server-side confirmation flag. A model-supplied `confirmed: true` argument is ignored; only the store's state counts.

---

## 4. Model choice

| Property | Value |
|---|---|
| Provider | Anthropic |
| Model | `claude-sonnet-5-5` |
| Why | Function calling reliability, strong instruction following, well-documented retry semantics, available via Anthropic SDK. |
| Fallback | `openai` with `gpt-4o` is also supported; switch by changing `.env`. |

**Estimated cost per processed case (Anthropic Sonnet):**  
~3–5 model calls per case × ~2 000 input tokens + ~500 output tokens ≈ 0.015–0.025 USD per case at current pricing. Token budget is capped at 50 000 per session.

---

## 5. Control matrix (RC1–RC10)

| Rule | Location | Implementation | Hardest part |
|---|---|---|---|
| RC1 — supplier exists and active | `src/domain/rules.ts` | Normalize tax ID (strip NIT check digit and punctuation); fall back to normalized name if no tax ID. | Normalizing Latin-American NIT format correctly without confusing buyer/seller IDs. |
| RC2 — approval contains "Approved" and sender is authorizer for cost center | `src/domain/rules.ts` | Case-insensitive body scan; exact email match in the cost-center approver list. | Approver list is cost-center-scoped, not global — a manager approved for a different cost center is still a blocker. |
| RC3 — total ≤ approver limit | `src/domain/rules.ts` | Direct comparison; finds the approver row matched in RC2. | Getting the per-approver, per-cost-center limit, not a global cap. |
| RC4 — subarea belongs to cost center | `src/domain/rules.ts` | Exact match in `subareas[]` from master data. | — |
| RC5 — quote total within ±2% | `src/domain/rules.ts` | `abs(quote.total − request.total_value) / request.total_value ≤ 0.02`. No quote → same confirmation. | Extracting the VAT-included TOTAL from the free-text quote (not the taxable base or VAT amount). |
| RC6 — tax code derived from supplier | `src/domain/rules.ts` | If missing, look up `default_tax_code` from supplier master; verify it exists in `tax-codes.json`. | — |
| RC7 — payment terms derived | `src/domain/rules.ts` | If missing, look up `default_payment_terms`; verify it exists in `payment-terms.json`. | — |
| RC8 — invoice date < request date → retroactive | `src/domain/rules.ts` | ISO date comparison; sets `retroactive: true` in the validation result and control log. | — |
| RC9 — approval date ≥ request date | `src/domain/rules.ts` | ISO date comparison. | — |
| RC10 — quantity × unit_price = total_value ± 1 | `src/domain/rules.ts` | Explicit arithmetic check with a 1-unit tolerance. | — |

**Hardest rule:** RC1 — the fixture quote contains the NIT with a check digit (`900.555.111-2`) while the supplier master stores the bare base ID (`900555111`). Stripping punctuation and the hyphenated suffix is necessary, and the buyer's own NIT appears in the same quote text.

---

## 6. Real SAP adapter design

### Integration option chosen: OData `API_PURCHASEORDER_PROCESS_SRV`

SAP's standard Purchase Order OData v2 service is the most maintainable option because it is SAP-certified, is exposed through SAP Business Technology Platform (BTP) without needing RFC port access, and maps directly to standard MM-purchasing fields. BAPI `BAPI_PO_CREATE1` is equally capable but requires an RFC connection and language-specific marshalling. SAP Integration Suite adds cost and operational overhead for this scope.

**Payload mapping from `PurchaseOrder` (PRD 7.4) to OData entity `A_PurchaseOrder`:**

| Our field | OData field |
|---|---|
| `company_code` | `CompanyCode` |
| `purchasing_org` | `PurchasingOrganization` |
| `supplier.sap_code` | `Supplier` |
| `payment_terms` | `PaymentTerms` |
| `currency` | `DocumentCurrency` |
| `items[n].description` | `to_PurchaseOrderItem.AccountAssignmentCategory` + `ShortText` |
| `items[n].quantity` | `OrderQuantity` |
| `items[n].unit_price` | `NetPriceAmount` |
| `items[n].cost_center` | `to_PurchaseOrderItemAccount.CostCenter` |
| `items[n].tax_code` | `TaxCode` |
| `approver.evidence_sha256` | Attachment via `A_PurchaseOrderAttachment` |

**Authentication:** credentials stored as environment variables on the server, never in the agent prompt, never in the frontend. For on-premise SAP: SAP Cloud Connector tunnel to BTP; for SAP BTP ABAP Environment: OAuth 2.0 client credentials flow.

**Idempotency under retries:** before calling `POST /sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder`, we call `GET` filtering by `ExternalDocumentID` (mapped to our `request_id`). If a matching PO is found, return its number without re-posting. This mirrors the `findOrderByReference` idempotency in the mock.

**Partial errors:** the OData response may return HTTP 201 with an error in `to_PurchaseOrderItem` sub-entity. We inspect the `__metadata` and message list; if any item failed, we surface the SAP message, write a `FAILED` control-log row, and do not mark the order created.

**Plan B if connection is not feasible:** generate a structured XLSX upload file in SAP MM format (`me21n` batch input) from the validated payload, attach the approval evidence, and write it to `out/<case>/sap-upload.xlsx`. The analyst copies it into SAP's batch-import transaction. This eliminates all manual field-by-field entry while the RFC/OData integration is being set up.

---

## 7. Retroactive POs — process reading

**Observation:** `req-005` demonstrates a purchase order created after an invoice (dated 2026-08-10) for a request raised 17 days later (2026-08-27). This means the good or service was already consumed before the organization formally authorized the purchase.

**What to tell management:** retroactive POs are a control gap. They indicate the approval process is bypassed when purchases are urgent, creating a risk of unapproved expenditure, incorrect cost-center allocation, and audit findings. Without measurement, there is no accountability.

**Proposed process change:** (1) Require the agent to flag and quantify retroactive POs in a weekly management report from `control.csv`. (2) After two quarters of data, set a retroactive-rate threshold (e.g. ≤5% of all POs by count). (3) For cases where a purchase is genuinely urgent, define an expedited-approval email template with an explicit "emergency authorization" subject line so the agent can recognize and classify it separately from true policy violations.

---

## 8. Decisions and trade-offs

**1. In-process session state vs. a database**
- Chosen: `Map<string, Session>` in the Fastify process.
- Discarded: Redis or SQLite.
- Why: A database adds startup complexity, a migration path, and container volumes with no benefit for a challenge-scope deployment. The PRD explicitly says persistence is not required.

**2. Confirmation as a server-side state machine vs. trusting the `confirmed` argument**
- Chosen: `InMemoryConfirmationStore` with a hashed payload; `po_create` checks the store, not the model argument.
- Discarded: accept `confirmed: true` as passed by the model.
- Why: the IMPLEMENTATION_BRIEF explicitly prohibits trusting model-supplied `confirmed` flags. A forged argument must not bypass the control.

**3. Single `src/tools/po.ts` for all tools vs. one file per tool**
- Chosen: one file; exports are named `read_package`, `validate`, etc. The server prefixes them as `po_<export>`.
- Discarded: `src/tools/po_read_package.ts`, `src/tools/po_validate.ts`, etc.
- Why: the PRD states the naming convention is `<file>_<export>` from `po.ts`. Five tools are cohesive enough to share a module without entanglement.

**4. Anthropic SDK + OpenAI SDK directly vs. LangChain / Vercel AI SDK**
- Chosen: thin provider adapters implementing our own `LlmAdapter` interface.
- Discarded: a meta-framework.
- Why: meta-frameworks add dependencies and hide errors; the challenge is 5 tools, not a production orchestration platform. Switching providers is a single-line `.env` change.

**5. `tsx` for dev + `tsc` for production vs. `bun`**
- Chosen: Node.js 20 + `tsx` + `tsc`.
- Why: `bun` is preferred by the PRD but `tsx` + `tsc` are more portable on the evaluator's machine and avoid `bun`-specific module-resolution edge cases with the Fastify + Zod 4 combination. `bun run demo.ts` works because Bun is compatible with the `tsx`/ESM module format.

---

## 9. Assumptions

1. The master data fixtures are complete and authoritative; no SAP live query is performed.
2. The approval body check is case-insensitive (`/approved/i`), since the PRD says "contains 'Approved'" but does not specify exact case.
3. `quote.txt` contains a single supplier section; the buyer's own company name and NIT appear in a separate section and are skipped by parsing the "PROVEEDOR" heading.
4. The ±2% RC5 tolerance uses `request.total_value` as the denominator (not the quote total).
5. RC3 uses the individual approver's `limit` field from the cost-center master data record, not a cost-center-level cap.
6. PO item number numbering starts at 10 and increments by 10 (SAP convention).
7. `unit` is derived from the description text: "hour" → `H`; otherwise `EA`.
8. The `quote_ref` in `PurchaseOrder.reference` is the supplier's tax ID extracted from the quote, since no invoice number is present in quote fixtures.
9. A `confirmed` flag passed directly to `po_create` is ignored; only the server-side `InMemoryConfirmationStore` counts as human authorization.

---

## 10. User-story coverage

| Story | Status | What is missing for production |
|---|---|---|
| US-1 Read package | Done | Real XLSX/PDF ingestion (P1); only JSON/TXT fixtures used |
| US-2 Validate (RC1–RC10) | Done | — |
| US-3 Build payload (with traceability) | Done | — |
| US-4 Generate evidence | Done (P0 txt + P1 pdf) | No production digital-signature requirement |
| US-5 Create PO (idempotent, control log) | Done | Real SAP OData/BAPI integration |
| US-6 Error handling | Done | — |
| AL1 Iteration cap | Done | — |
| AL2 Model cannot assert tool values | Done | Enforced via prompt + server-side re-validation in `po_create` |
| AL3 Human confirmation | Done | — |
| AL4 Tool calls in chat history + log.jsonl | Done | — |
| AL5 Error shown in plain language | Done | — |

---

## 11. Security and confirmation controls

### No LLM-supplied authorization

The `po_create` tool accepts a `confirmed` argument from the model, but that argument is
**ignored**. The only authorization path is:

1. `po_validate` detects confirmable exceptions and calls `InMemoryConfirmationStore.setPending(requestId, payloadHash, codes)`.
2. The server returns `needsConfirmation: true` to the frontend.
3. The human clicks **Confirm** in the browser, which sends `POST /api/chat { confirm: true }`.
4. The server calls `store.confirm(requestId, payloadHash)` with the hash it generated — not one from the model.
5. `po_create` calls `store.check(requestId, payloadHash)`; only `'confirmed'` permits continuation.

A forged `confirmed: true` in the model's tool call is structurally irrelevant.

### Payload hash binding

Confirmation is bound to the exact SHA-256 hash of the serialized payload. If the model
rebuilds the payload with different values, the hash changes and the old confirmation is
invalidated. This prevents a confirmed exception from being transferred to a different order.

### Single-use tokens

State transitions: `NONE → PENDING → CONFIRMED → CONSUMED`. Once consumed, the token cannot
re-authorize. An idempotent retry finds the existing PO via `findOrderByReference` and returns
without needing re-confirmation.

### Server-side re-validation in `po_create`

Even after confirmation, `po_create` re-reads the fixture and re-runs RC1–RC10 from the
authoritative sources. A model-supplied blocker list is never trusted.

### Secrets and transport

- LLM API keys are read from environment variables only; they never appear in:
  - HTTP responses
  - Tool results
  - `log.jsonl` (tool log records summaries, not payloads)
  - The browser bundle (all model calls are server-side)
- The `GET /api/health` endpoint returns `{ ok, provider, model, llmConfigured }` with no key material.
- Rate limiting (`RATE_LIMIT_PER_MINUTE`, default 30 req/min per IP) and a 2 000-character
  message length cap protect the public endpoint.

### Path traversal prevention

`po_read_package` validates `case_id` against `/^[a-z0-9-]+$/` and verifies the resolved
path starts with the fixtures root before opening any file.

---

## 11a. Phase 8 — Reusable Module, PDF Evidence, and Repository Cleanup

### Phase 8-A: Reusable Agent Module (PRD 9.4 Bonus)

The `module/` directory packages the agent for use by other agent platforms without depending on the Fastify HTTP server:

```
module/
├── agent.md                        # YAML frontmatter (description, mode: primary, permission: edit/bash deny) + agent system prompt
├── tools/po.ts                     # re-export of the five tools from src/tools/po.ts
└── skill/purchase-orders/SKILL.md  # YAML frontmatter (name, description) + process knowledge
```

**Canonical sources and divergence prevention:**

- `module/agent.md` body = `agent/prompt.md` (verified byte-for-byte)
- `module/skill/purchase-orders/SKILL.md` body = `src/knowledge/purchase-orders.md` (verified byte-for-byte)
- `module/tools/po.ts` re-exports from `src/tools/po.ts` — no duplication of business logic

`npm run module:check` (implemented in `scripts/module-check.ts`) verifies both text files against their canonical sources and exits non-zero on divergence. CI/automated reviews should add this check.

**Portability:** importing `module/tools/po.ts` initializes only Node.js built-ins and `zod`. No Fastify server, no LLM adapter, and no API key is loaded on import. The tools can be called directly with a `ToolCtx` containing `{ directory, sessionId }`.

**Integration example:**
```typescript
import { read_package, validate } from "./module/tools/po.js"
const result = JSON.parse(await read_package.execute({ case_id: "req-001" }, { directory: ROOT, sessionId: "s1" }))
```

**Security invariants preserved:** RC1–RC10 blockers, per-session confirmation state machine, server-side re-validation in `po_create`, and path traversal prevention are all in `src/tools/po.ts` and are therefore included via the re-export.

### Phase 8-B: PDF Approval Evidence

`po_generate_evidence` now produces two artifacts per eligible case:

| Artifact | Type | Purpose | PRD Priority |
|----------|------|---------|--------------|
| `out/<case>/approval.txt` | Plain text | Canonical evidence + SHA-256 hash | P0 (unchanged) |
| `out/<case>/approval.pdf` | PDF | Same email headers + body in PDF format | P1 (bonus) |

**Implementation:** `pdf-lib` (pure TypeScript, no native dependencies, zero known CVEs). The PDF is generated inside `src/tools/po.ts` in a helper function `generateApprovalPdf()` that is non-fatal — a PDF generation failure does not affect `approval.txt` or the SHA-256. The `po_generate_evidence` tool result now includes an optional `pdf_path` field alongside the existing `path` and `sha256` fields.

**SHA-256 semantics unchanged:** the hash is computed over `canonicalText` only (email headers + body), exactly as before. The `---\nSHA256:` trailer line is not part of the hashed content. Adding PDF generation does not touch this computation.

**Trade-off:** `pdf-lib` is a runtime dependency (~350 kB), but it is pure TypeScript and introduces no native bindings, Chromium, or subprocess. The alternative (`pdfkit`) requires a binary font loader that breaks in serverless environments.

### Phase 8-C: XLSX Ingestion (Deferred)

The optional `po_read_excel` tool was evaluated and deferred due to a security risk.

The only widely-used Node.js XLSX parsing package (`xlsx` / SheetJS CE) has two unfixed known security vulnerabilities:

| Advisory | Severity | Status |
|----------|----------|--------|
| GHSA-4r6h-8v6p-xvw6 — Prototype Pollution | High | No fix available |
| GHSA-5pgg-2g8v-p4x9 — ReDoS | High | No fix available |

`npm audit --omit=dev` would report 1 high severity vulnerability after installing `xlsx`. No other maintained package with equivalent `.xlsx` parsing capability was available at implementation time.

**Decision:** per AGENTS.md ("if any optional feature threatens mandatory functionality, prioritize preserving the working implementation") and the Phase 8-C instruction ("if implementing XLSX would require a high-risk architectural change, report that risk"), the feature was deferred. The JSON fixture workflow is unaffected.

**Note:** SheetJS CE is not the only XLSX library. Alternatives include `exceljs` (no known CVEs at this time, but larger) and WASM-based parsers. They were evaluated and not implemented to keep this release focused on the mandatory and higher-priority Phase 8-A/B deliverables.

### Local .env Loading

`src/server.ts` loads `.env` using Node.js built-ins (`readFileSync` + a minimal line parser)
at module initialization time, before `buildServer()` is called. This avoids adding a `dotenv`
dependency while supporting the reviewer's local workflow.

Key properties:
- Uses `??=` semantics: never overwrites variables already set in the environment (Render Dashboard vars take priority)
- Silently skips missing `.env` (try/catch on ENOENT)
- Only runs in the server process — Vite frontend is a separate process and never sees server env vars
- Works on Node.js 20+; no Node.js 22-specific flag required
- Production behavior on Render is unchanged (`.env` does not exist there)

**Verified:** server started with dummy `ANTHROPIC_API_KEY` in `.env` → `GET /api/health` returned `{"llmConfigured":true}`. Server started without `.env` → `{"llmConfigured":false}`. No real LLM call was made in either test.

### Reusable Module — Portability Model

The module is distributed as part of this repository. It is **not** a standalone npm package.

**Distribution:** clone or copy the repository. After `npm install && npm run build`:
- TypeScript source: import `module/tools/po.ts` with a TypeScript runner (`tsx`)
- Compiled JS: import `dist/module/tools/po.js` with `node`

The compiled module re-exports from `dist/src/tools/po.js`. It requires `dist/src/domain/*` and `dist/src/sap/*` to be present (they are part of the same repository build). Runtime package dependencies are `zod` and `pdf-lib` (declared in `package.json`).

**Portability tests:** `tests/phase8/module-portability.test.ts` spawns 6 independent Node.js subprocesses from a temporary directory, each importing `dist/module/tools/po.js` and executing tools against real fixture data. All tests pass without Fastify or LLM credentials.

### Repository Cleanup

| Item | Change |
|------|--------|
| `src/server.ts` | Added inline `.env` loader (built-ins only, no dotenv dep) |
| `tsconfig.build.json` | New: production-only TS config; compiles `src/**/*` + `module/**/*`, excludes tests, demo, scripts |
| `package.json build:server` | Updated to use `tsconfig.build.json` instead of `tsconfig.json` |
| `render.yaml buildCommand` | Updated to `npm ci --include=dev && npm run build` (ensures devDependencies are installed) |
| `.gitignore` | Expanded: `.env.*` + `!.env.example`, `coverage/`, `test-results/`, `*.log`, `.DS_Store`, editor dirs |
| `package.json module:check` | New script: `tsx scripts/module-check.ts` |
| `scripts/module-check.ts` | New: validates module/agent.md and SKILL.md against canonical sources |
| `module/` | New: reusable module directory (Phase 8-A) |
| `tests/phase8/` | New: Phase 8 test suite (module + portability + PDF) |

---

## 12. Testing and verification

### Test suite

| Suite | File | Coverage |
|-------|------|---------|
| Normalize | `tests/domain/normalize.test.ts` | NIT stripping, name normalization, quote/invoice parsing |
| Rules | `tests/domain/rules.test.ts` | All 10 RC rules + boundary conditions + oracle matrix |
| Tools | `tests/tools/po.test.ts` | All 6 fixture cases, idempotency, path traversal, edge cases |
| Confirmation | `tests/session/confirmation.test.ts` | State machine, TTL expiry, replay prevention, hash binding |
| Agent loop | `tests/integration/agent-loop.test.ts` | Deterministic mock LLM — all 6 cases, iteration cap, error recovery |
| Frontend | `web/src/` (vitest + jsdom) | React components, ChatWindow, ConfirmationBanner, ToolCallCard |
| Browser | `tests/browser-acceptance.ts` | Playwright end-to-end — all 6 cases, mobile viewport, screenshot |

**Result (2026-10-29 — Phase 8):**

```
Test Files  10 passed | 2 skipped (12)
      Tests  282 passed | 7 skipped (289)
```

Two skipped test *files* are the live-provider LLM integration tests (`tests/llm/`), which
require a real API key and are explicitly skipped when no key is set. The 7 skipped individual
tests are within those files. All other tests are deterministic and pass without any API key.

Phase 8 added 23 new tests across two files:
- `tests/phase8/module.test.ts` — 17 tests (Phase 8-A: module exports, Zod contracts, frontmatter, content consistency, standalone execution)
- `tests/phase8/pdf-evidence.test.ts` — 6 tests (Phase 8-B: PDF generation, validity, SHA integrity)

**Live LLM integration has not been end-to-end tested against a real provider.** Insufficient
API credits prevented a funded run of `tests/integration/live-workflows.test.ts` or a real
conversation through the web UI. The LLM adapter (`AnthropicAdapter`, `OpenAiAdapter`),
tool-call dispatch, and agent loop have been verified by tests using a deterministic stub
adapter. The live-provider path (sending real requests to Anthropic or OpenAI, receiving
tool calls, and completing a full PO workflow) remains unconfirmed until a reviewer with a
funded key tests it.

### Browser acceptance

```
[browser] PASS req-001  [browser] PASS req-002  [browser] PASS req-003
[browser] PASS req-004  [browser] PASS req-005  [browser] PASS req-006
Browser acceptance: 6 passed, 0 failed (deterministic adapter)
```

Tests ran against the real Fastify server with a deterministic LLM adapter — no mock HTTP,
no skipped tool execution.

### Build and type checking

```
npm run typecheck  →  exit 0  (strict TypeScript, no `any`)
npm run build      →  exit 0  (tsc + Vite)
npm audit --omit=dev  →  found 0 vulnerabilities
```

### Demo

```
npm run demo  →  exit 0  (all 6 cases correct, idempotency verified)
```

---

## 13. AI-Assisted Engineering Process

### Tools and workflow

| Tool | Tasks |
|------|-------|
| Claude Opus (Anthropic) via Conductor | Implementation planning and architecture; initial code generation for domain rules, SAP mock, tool implementations, LLM adapter layer, agent loop, confirmation state machine, test suites, and documentation drafts |
| Claude Sonnet (Anthropic) via Conductor | Phase-by-phase implementation and iteration; subsequent code generation and revision rounds within each phase |
| ChatGPT (OpenAI) | PRD analysis and challenge strategy; architectural review of the proposed approach; assessment of implementation reports at phase boundaries; identification of potential defects and edge cases; preparation of validation criteria and test expectations |

### Requirements analysis and planning

ChatGPT was used to walk through the PRD and identify ambiguities, edge cases, and compliance
risks before implementation started. Each assumption was classified as `[PRD]`, `[FIXTURE]`,
`[DESIGN]`, or `[AMBIGUITY]` and documented. The plan was reviewed and approved by the engineer
before any code was written.

Claude (Opus and Sonnet via Conductor) was used for all code generation across phases. The
generated code was reviewed for PRD compliance and correctness; decisions that required
interpreting ambiguous requirements were made by the engineer (see below).

### AI-assisted code generation

Claude generated initial implementations for:
- `src/domain/rules.ts` — all 10 RC functions
- `src/domain/normalize.ts` — NIT and name normalization, quote/invoice text extraction
- `src/tools/po.ts` — the 5-tool implementation
- `src/llm/anthropic.ts` and `src/llm/openai.ts` — provider adapters
- `src/server.ts` — agent loop with token budget and iteration cap
- Test suites for all layers

Generated output was not accepted verbatim in all cases; see "Bugs discovered in AI-generated
suggestions" for specific corrections that were required. Not every generated line was manually
inspected at the character level — review was focused on correctness of business logic,
architecture decisions, and PRD compliance.

### Human review of architecture and business rules

The following decisions were made explicitly by the engineer, not delegated to AI:

- **RC3 design choice**: two readings of "approver limit" were possible — Reading A: the
  specific approver's individual authorization ceiling, or Reading B: a single maximum capacity
  attached to the cost center itself. Reading A was implemented (`applyRC3` compares
  `totalValue > approverRecord.limit`). The fixture data supports this: each approver row in
  `cost-centers.json` carries its own `limit` field (e.g. mlopez: 50 000 000 COP, dgarcia:
  200 000 000 COP). There is no separate cost-center-level cap in the master data. Reading B
  was considered and rejected because no such field exists in the fixtures and inventing a
  default would not be grounded in authoritative data.
- **RC5 denominator**: the tolerance check uses `request.total_value` as denominator, not the
  quote total. Verified by reading the PRD and confirmed by a boundary test.
- **Confirmation state machine**: the 5-state machine (`NONE → PENDING → CONFIRMED → CONSUMED`;
  `EXPIRED`) with payload hash binding was designed by the engineer; Claude generated the
  TypeScript implementation from the specification.
- **`po_create` re-validation**: the decision to re-run all RC rules server-side inside `po_create`
  (rather than trusting the model's validation summary) was made explicitly against an AI
  suggestion to omit the redundant check.

### Bugs discovered in AI-generated suggestions

1. **Double-consumption risk**: An early `po_create` implementation called `store.consume()` before
   confirming the SAP write. A test was written that verified the confirmation remained available
   for retry if the SAP write threw; the generated code failed it. Fixed: `consume()` moved to
   after successful persistence.
2. **NIT normalizer**: the first generated regex stripped only trailing `-N` where N is a single
   digit. Fixed to strip `-\d+$` to handle multi-digit check codes.
3. **RC2 case sensitivity**: the generated approval body check used `.includes('Approved')` (exact
   case). PRD says "contains 'Approved'" without casing constraint; fixed to a `/approved/i` test.
4. **Quote total parser**: the initial regex matched the VAT-only sub-total line rather than the
   `TOTAL (VAT included)` line. Caught by the `parseQuoteTotal(req004QuoteText) === 26500000`
   test; fixed by anchoring the regex to the `TOTAL` keyword.

### Corrections made during implementation

- Zod v4 changed the `zod-to-json-schema` API. The generated code used the v3 `zodToJsonSchema`
  import path; corrected to the v4 `z.toJSONSchema()` call after inspecting the Zod 4 changelog.
- The `@fastify/rate-limit` plugin was generated using the v9 API; updated to v10 because the
  project uses Fastify v5.

### Automated testing and manual validation

All 10 RC rules have at least one positive and one negative test case. Boundary conditions
(RC5 at exactly 2%, RC10 ± 1 COP tolerance, TTL expiry at the millisecond boundary) are
explicitly tested. No test was written after the fact to make a passing claim; all tests were
authored before the implementation was considered complete.

Manual validation was performed by running `npm run demo` and inspecting `out/demo-*/` artifacts,
verifying that `traceability.json` maps every field to its correct source and that
`approval.txt` contains the expected SHA-256 hash.

### Separation of AI assistance from engineering decisions

AI was used as a code-generation and documentation accelerator. All business-rule correctness
claims, architectural decisions, and security properties were verified by:
- Explicit test cases with known expected outputs derived from fixture reading
- TypeScript strict-mode enforcement (no `as any`, no `as unknown as T`)
- Server-side re-validation independent of the LLM adapter

No business logic is delegated to the LLM at runtime. The LLM is solely a dispatcher: it
decides which tool to call next; all validation, payload construction, and SAP creation are
deterministic backend functions.

---

## 14. Deployment

### Local production

```bash
npm run build   # compiles TypeScript + Vite → dist/
npm start       # node dist/src/server.js on PORT (default 3000)
```

### Render Free (selected deployment platform)

The service is deployed as a single Render Free Web Service that runs the Fastify backend
and serves the compiled React frontend as static files from `dist/web/`.

**render.yaml** (committed to repository root):

```yaml
services:
  - type: web
    name: sap-purchase-orders
    runtime: node
    plan: free
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /api/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: LLM_PROVIDER
        sync: false
      - key: LLM_MODEL
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
```

**Deployment steps (Render Dashboard):**

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**.
2. Connect the GitHub repository `Jeh212/sap-purchase-orders`.
3. Select branch `Jeh212/periferia-challenge-03-plan`.
4. Render auto-detects `render.yaml`; confirm the settings shown.
5. In **Environment Variables**, add:
   - `LLM_PROVIDER` = `anthropic`
   - `LLM_MODEL` = `claude-sonnet-5-5`
   - `ANTHROPIC_API_KEY` = `<reviewer's key>`
6. Click **Deploy**.
7. Wait for the build to complete (~2 minutes) and visit the assigned `*.onrender.com` URL.

**Starting without a key (reviewer-configurable):**

The service starts and serves the UI even if no API key is set. The health endpoint
(`GET /api/health`) returns `{"ok":true,"llmConfigured":false}`. The `/api/chat` endpoint
returns HTTP 503 with a human-readable error until `LLM_PROVIDER`, `LLM_MODEL`, and the
corresponding key are set. The reviewer can add or update environment variables in the
Render Dashboard under **Environment** without redeploying.

**Ephemeral storage:**

Render Free uses ephemeral storage. The SAP mock writes to `out/sap/orders.jsonl` and
`out/sap/counter.txt` in the project directory. These paths are writable at runtime and the
mock initializes from an empty directory on first use. Counter recovery (`repairCounter()`)
rebuilds the PO counter from `orders.jsonl` on startup, so sequential PO numbers are
consistent within a running instance. **All output files are lost when the instance restarts
or the free-tier service sleeps.** This is acceptable for a demonstration; production deployments
would need a database or persistent volume.

**Live URL:** configured after deployment; update this line with the public URL before submission.

### Security posture for cloud deployment

- LLM API keys are set as environment variables in the Render Dashboard — they are never stored
  in the repository or the build artifact.
- The frontend bundle contains no secrets; it communicates only with the `/api/*` routes of
  the same origin.
- Rate limiting is enabled by default (30 req/min per IP); raise `RATE_LIMIT_PER_MINUTE` if
  the reviewer encounters 429 errors during testing.
- No reviewer API keys are accepted or stored by the application.

---

## 15. Risks and mitigations for production


| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SAP OData service unavailable or not licensed | Medium | High | Implement Plan B (structured upload file) from day one; OData integration as a parallel track |
| Model hallucinates a PO field | Low | High | All fields come from tools; prompt and server-side re-validation in `po_create` prevent LLM-invented values reaching SAP |
| Retroactive POs confirmed silently in bulk | Medium | Medium | Require per-PO confirmation; add a management report with retroactive-rate KPI |
| API key exhausted by a single analyst session | Medium | Low | Token budget + rate limiter per IP; rotate keys per deployment environment |
| In-process session state lost on restart | High | Low | Acceptable for a demo; for production use Redis or a database with session TTL |
| Concurrent multi-process writes to `orders.jsonl` | Low (single Node process) | High | Mutex in `FileSapMock` guards single-process concurrency; for horizontal scaling, replace with a database sequence or distributed lock |
| Approval email spoofed (sender header only) | Medium | High | In production, verify approval via the corporate email security gateway (DKIM/DMARC) or an internal workflow system, not a raw email body |
