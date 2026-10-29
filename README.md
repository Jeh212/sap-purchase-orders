# SAP Purchase Orders — Conversational Agent (Challenge 03)

**Repository:** https://github.com/Jeh212/sap-purchase-orders

**Live demo:** https://sap-purchase-orders.onrender.com/

> The hosted URL is public. Real LLM chat requires a configured API key (see below). The
> deterministic demo and all automated tests work without any key.

A conversational AI agent that automates SAP purchase-order preparation. The analyst types a
request into a web chat; the agent reads the package, validates it against master data, applies
10 business controls (RC1–RC10), builds a typed SAP payload with approval evidence (plain text
+ PDF), and creates the purchase order in a simulated SAP — blocking invalid orders and
requesting explicit human confirmation for each exception.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20 or later | `node --version` to check |
| npm | 10 or later | bundled with Node 20 |

An LLM API key is **not** required to run the deterministic demo or the test suite. It is
required only to run the real conversational agent.

---

## Installation

```bash
git clone https://github.com/Jeh212/sap-purchase-orders.git
cd sap-purchase-orders
npm install
```

> Node.js 20 or later is required. Node.js 22 is recommended for local development
> (the `.env` loader in `src/server.ts` uses only built-ins and works on all supported versions).

---

## Configuration

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

`src/server.ts` loads `.env` at startup using Node.js built-ins — no `dotenv` package is
required. Variables already set in the environment (e.g. Render Dashboard) take priority.
The server starts and serves the UI even if `.env` is absent or empty; only `/api/chat`
returns HTTP 503 until a valid LLM_PROVIDER and key are configured.

### Option A — Anthropic (default)

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=sk-ant-...
```

### Option B — OpenAI

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

### All configuration variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROVIDER` | For real agent | — | `anthropic` or `openai` |
| `LLM_MODEL` | For real agent | — | e.g. `claude-sonnet-5-5` or `gpt-4o` |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Your Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | Your OpenAI API key |
| `PORT` | No | `3000` | HTTP port for the backend |
| `MAX_ITERATIONS` | No | `25` | Agent loop iteration cap per turn |
| `MAX_TOKENS_PER_SESSION` | No | `50000` | Token budget per session |
| `MAX_TOKENS_PER_RESPONSE` | No | `4096` | Max tokens in one model response |
| `LLM_TIMEOUT_MS` | No | `30000` | Provider request timeout (ms) |
| `RATE_LIMIT_PER_MINUTE` | No | `30` | Max `/api/chat` requests per IP per minute |
| `OUT_DIR` | No | `./out` | Runtime artifacts directory |

The demo and test suite make no LLM calls and do not read any API key.

---

## Running the Full Application

Start both the backend (Fastify on port 3000) and the React frontend (Vite on port 5173) with a
single command:

```bash
npm run dev
```

Then open `http://localhost:5173` in your browser.

To stop: press `Ctrl+C`.

Type one of the following messages to process a fixture scenario:

| Message | Expected result |
|---------|----------------|
| `Process req-001` | PO created automatically (happy path) |
| `Process req-002` | Blocked — RC1: supplier not found |
| `Process req-003` | Blocked — RC2: approver not authorized for this cost center |
| `Process req-004` | Confirmation required (RC5: quote > 2% tolerance) → confirm → PO created |
| `Process req-005` | Confirmation required (RC8: retroactive) → confirm → PO created |
| `Process req-006` | Confirmation required (RC6: tax code derived) → confirm → PO created |

Each tool call appears as a collapsible card in the chat. A confirmation banner highlights
cases that require explicit human consent; click **Confirm** to authorize and proceed.

---

## LLM Configuration

The reviewer provides their **own** API key. It is read from `.env` on the server; it is never
sent to the browser, logged, or included in any API response.

- Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=sk-ant-...` for Anthropic Claude.
- Set `LLM_PROVIDER=openai` and `OPENAI_API_KEY=sk-...` for OpenAI GPT.
- Change `LLM_MODEL` to any supported model for that provider.

The demo (`npm run demo`) and the entire test suite work without any API key.

---

## Deterministic Demo (no LLM key required)

Processes all six official fixture cases using deterministic backend logic only. No model call
is made. No API key is required.

```bash
npm run demo
```

Expected output:

```
SAP Purchase Orders deterministic demo
case    eligible blockers   confirmations  retroactive  po_number    idempotent_retry
req-001 true     -          -              false        4500000001   true
req-002 false    RC1        -              false        -            -
req-003 false    RC2        -              false        -            -
req-004 true     -          RC5            false        4500000002   -
req-005 true     -          RC8            true         4500000003   -
req-006 true     -          RC6            false        4500000004   -
Artifacts: out/demo-<timestamp>
Assertions: PASS
```

Exit code 0 means all six cases returned their expected outcome and idempotency was verified
for req-001 (run twice, single PO). req-004 uses an explicit simulated human confirmation before
the PO is created.

Generated files are written to `out/demo-<timestamp>/`:

| File | Description |
|------|-------------|
| `out/demo-*/req-001/approval.txt` | Canonical approval email + SHA-256 digest |
| `out/demo-*/req-001/approval.pdf` | PDF version of the approval email (Phase 8 P1) |
| `out/demo-*/req-001/traceability.json` | Every PO field mapped to its data source |
| `out/demo-*/sap/orders.jsonl` | Append-only log of created purchase orders |
| `out/demo-*/control.csv` | Audit log with CREATED, BLOCKED, PENDING, IDEMPOTENT rows |

---

## Testing

```bash
# Type-check all TypeScript
npm run typecheck

# Backend unit + integration tests (no API key required)
npm run test:backend

# Frontend React component tests
npm run test:frontend

# Full suite
npm test

# Compile TypeScript + bundle React
npm run build

# Security audit (production dependencies only)
npm audit --omit=dev
```

Expected result for `npm run test:backend`:

```
Test Files  10 passed | 2 skipped (12)
      Tests  282 passed | 7 skipped (289)
```

The 2 skipped test *files* are the live-provider integration tests (`tests/llm/`,
`tests/integration/live-*.ts`). They are skipped automatically when `RUN_LIVE_LLM_TESTS=true`
is not set. All other tests run without any API key.

To run live LLM integration tests (requires a funded API key):

```bash
RUN_LIVE_LLM_TESTS=true node --env-file=.env ./node_modules/.bin/vitest run \
  tests/integration/live-provider.test.ts \
  tests/integration/live-workflows.test.ts
```

### Browser acceptance tests

Runs all six scenarios through the React frontend using a deterministic adapter (no real
model call). Requires Google Chrome.

```bash
npx tsx tests/browser-acceptance.ts
```

Expected output:

```
[browser] PASS req-001
[browser] PASS req-002
[browser] PASS req-003
[browser] PASS req-004
[browser] PASS req-005
[browser] PASS req-006
Browser acceptance: 6 passed, 0 failed (deterministic adapter)
```

---

## API Reference

| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| `POST` | `/api/chat` | `{ sessionId?: string, message: string, confirm?: boolean }` | `{ reply, toolCalls[], needsConfirmation, pendingConfirmation, tokenUsage, sessionId }` |
| `GET` | `/api/sessions/:id` | — | Full event history, pending confirmation state, token usage |
| `GET` | `/api/health` | — | `{ ok, provider, model, llmConfigured }` — no API key material |

To send a human confirmation after the agent pauses:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","message":"","confirm":true}'
```

---

## Six Fixture Scenarios

All input files are under `fixtures/challenge-03/requests/<case>/`. They are read-only.

| Case | Scenario | RC triggers |
|------|----------|-------------|
| req-001 | Happy path — TecnoSuministros, CC-1010, mlopez approved | None |
| req-002 | Unknown supplier NIT 901999000 | RC1 blocker |
| req-003 | fvargas not authorized for CC-2020 | RC2 blocker |
| req-004 | Quote 26.5 M vs. request 25 M COP (+6%) | RC5 confirmation |
| req-005 | Invoice date 2026-08-10 predates request 2026-08-27 | RC8 confirmation (retroactive) |
| req-006 | No tax code or payment terms — both derived from supplier | RC6 confirmation |

---

## Deployment

### Local production build

```bash
npm run build      # TypeScript + Vite → dist/
npm start          # node dist/src/server.js on PORT (default 3000)
```

The compiled server is at `dist/src/server.js`. It serves the React build as static files from
`dist/web/` and reads configuration from environment variables:

```bash
PORT=3000 LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-5-5 \
  ANTHROPIC_API_KEY=sk-ant-... node dist/src/server.js
```

### Render Free (cloud deployment)

The service is configured for Render Free via `render.yaml` at the repository root.

**Steps (Render Dashboard):**

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**.
2. Connect the repository `Jeh212/sap-purchase-orders`, branch `Jeh212/periferia-challenge-03-plan`.
3. Render auto-detects `render.yaml`; confirm the settings.
4. Under **Environment Variables**, add:
   - `LLM_PROVIDER` = `anthropic`
   - `LLM_MODEL` = `claude-sonnet-5-5`
   - `ANTHROPIC_API_KEY` = `<your key>`
5. Click **Deploy** (~2 min build).

The server starts and serves the UI even without credentials. The `/api/chat` endpoint returns
HTTP 503 until the key variables are set. The reviewer can add or update environment variables
in the Dashboard under **Environment** without redeploying.

**Storage note:** Render Free uses ephemeral storage. Output files (`out/sap/orders.jsonl`,
`control.csv`) are written to the container filesystem and are lost when the instance restarts
or sleeps. Counter recovery on startup maintains sequential PO numbers within a running session.
This is acceptable for a demonstration; production use would require a database.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/api/chat` returns HTTP 503 | LLM provider not configured | Add `LLM_PROVIDER`, `LLM_MODEL`, and the key to `.env`; the server starts fine without credentials |
| `Your credit balance is too low` | API key has no credits | Add credits at console.anthropic.com or switch to a funded key |
| Agent returns "I have reached the iteration limit" | Too many tool calls | Increase `MAX_ITERATIONS` in `.env` |
| `case not found` tool error | Fixture directory missing | Verify `fixtures/challenge-03/requests/<case>/` exists |
| Confirmation banner does not dismiss | Session/hash mismatch | Reload to start a new session |
| Port 3000 already in use | Another process | Set `PORT=3001` in `.env`; update `web/vite.config.ts` proxy |
| Browser acceptance tests fail with `browserType.launch` | Chrome not found | Install Google Chrome |
| `npm run typecheck` fails | Type error | Restore strict types; no `as any` |

---

## Reusable Module (Phase 8 Bonus)

The agent is also packaged as a standalone module usable without the Fastify server:

```
module/
├── agent.md                        # agent definition (YAML frontmatter + system prompt)
├── tools/po.ts                     # re-exports the five tools — no HTTP server required
└── skill/purchase-orders/SKILL.md  # process knowledge (YAML frontmatter + knowledge body)
```

**Using the module:**

```typescript
import { read_package, validate, generate_evidence, build_payload, create } from "./module/tools/po.js"

const result = JSON.parse(
  await read_package.execute({ case_id: "req-001" }, { directory: ROOT, sessionId: "s1" })
)
```

The module re-exports from `src/tools/po.ts` and the compiled output is at
`dist/module/tools/po.js`. No Fastify, no LLM adapter is initialized on import.

**Distribution model:** the module depends on `src/domain/*` and `src/sap/*` (business logic)
which are part of this repository. It is not a standalone npm package — consumers clone or
copy the full repository and import either the TypeScript source (with a TS runner such as
`tsx`) or the compiled JS from `dist/module/tools/po.js`.

Runtime dependencies: `zod`, `pdf-lib` (declared in `package.json`).

Run the consistency check to verify the module has not diverged from canonical sources:

```bash
npm run module:check
```

---

## Optional Features (Phase 8)

### PDF Approval Evidence

`po_generate_evidence` now produces both:
- `out/<case>/approval.txt` — the canonical P0 artifact (SHA-256 content hash unchanged)
- `out/<case>/approval.pdf` — a valid PDF with the same email headers and body (P1 bonus)

The PDF path is returned in `po_generate_evidence`'s result as `pdf_path`. The SHA-256 in
`approval.txt` remains canonical; it is not affected by PDF generation.

### XLSX Ingestion (Deferred)

The `po_read_excel` optional tool was deferred. The primary candidate (`xlsx` / SheetJS CE)
has known unfixed high-severity security vulnerabilities (prototype pollution, ReDoS —
GHSA-4r6h-8v6p-xvw6 and GHSA-5pgg-2g8v-p4x9). Alternative libraries (e.g. `exceljs`)
exist and could be evaluated, but were not implemented to keep this release focused on the
mandatory deliverables. The JSON fixture workflow is unaffected. `npm audit --omit=dev`
reports 0 vulnerabilities.

---

## Known Limitations

- **SAP is simulated.** `src/sap/mock.ts` writes to local files; no real RFC or OData connection is made. `SOLUTION.md` section 6 describes the real integration design.
- **File-backed persistence is single-process.** `orders.jsonl` and `control.csv` are plain files; a multi-process or multi-server deployment would require a database or distributed lock.
- **Live LLM testing requires reviewer credentials and credits.** The 7 skipped tests in `tests/integration/live-*.ts` require `RUN_LIVE_LLM_TESTS=true` and a funded API key. All other tests are deterministic and require no key.
- **Live LLM flow has not been end-to-end tested against a real provider.** Insufficient API credits prevented a funded live run. All deterministic paths (tools, validation, SAP mock) are fully tested. The 7 skipped tests in `tests/integration/live-*.ts` and `tests/llm/` cover the live-provider path and require a funded key plus `RUN_LIVE_LLM_TESTS=true`.
- **Hosted application limitations.** The service at `https://sap-purchase-orders.onrender.com/` is deployed on Render Free. Real LLM chat requires the reviewer to configure their own API key via the Render Dashboard (see Deployment section). Without credentials, `GET /api/health` returns `llmConfigured: false` and `/api/chat` returns HTTP 503. Render Free storage is ephemeral — output files are lost on instance restart.
