# SAP Purchase Orders — Conversational Agent (Challenge 03)

A conversational AI agent that automates SAP purchase-order preparation. The analyst pastes a
request package into a web chat; the agent reads, validates against master data, applies
10 business controls (RC1–RC10), builds a typed SAP payload with approval evidence, and creates
the purchase order in a simulated SAP — blocking invalid orders and requesting explicit human
confirmation for each exception.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20 or later | `node --version` to check |
| npm | 10 or later | bundled with Node 20 |
| Bun (optional) | 1.1 or later | alternative runtime for `demo.ts` |
| Google Chrome | any | required only for browser acceptance tests |

An LLM API key is **not** required to run the deterministic demo or the test suite. It is
required only to run the real conversational agent.

---

## Installation

```bash
git clone <repo-url>
cd challenge-03
npm install
```

---

## Configuration

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

### Option A — Anthropic (default)

```
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=sk-ant-...
```

### Option B — OpenAI

```
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

### All configuration variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROVIDER` | For real agent | — | `anthropic` or `openai` |
| `LLM_MODEL` | For real agent | — | e.g. `claude-sonnet-5-5` or `gpt-4o` |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | OpenAI API key |
| `PORT` | No | `3000` | HTTP port |
| `MAX_ITERATIONS` | No | `25` | Agent loop iteration cap per turn |
| `MAX_TOKENS_PER_SESSION` | No | `50000` | Token budget per session |
| `MAX_TOKENS_PER_RESPONSE` | No | `4096` | Max tokens in one model response |
| `LLM_TIMEOUT_MS` | No | `30000` | Provider request timeout (ms) |
| `RATE_LIMIT_PER_MINUTE` | No | `30` | Max `/api/chat` requests per IP per minute |
| `OUT_DIR` | No | `./out` | Runtime artifacts directory |

The demo and test suite read no LLM keys; they will work even with an empty `.env`.

---

## Deterministic demo (no LLM key required)

Processes all six official fixture cases using deterministic backend logic only. No model call
is made.

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

Exit code 0 means all six cases returned their expected outcome and idempotency was verified.

---

## Automated tests

```bash
# Full suite (backend + frontend)
npm run test

# Backend only (unit + integration + agent-loop)
npm run test:backend

# Frontend only (React component tests)
npm run test:frontend

# TypeScript type checking
npm run typecheck

# Compile for production
npm run build
```

Expected output for `npm run test:backend`:

```
Test Files  8 passed | 2 skipped (10)
      Tests  259 passed | 7 skipped (266)
```

Skipped test files are the live-provider integration tests (`tests/llm/`) which require a real
API key. They are skipped automatically when no key is present.

---

## Browser acceptance tests

Runs all six scenarios through the React frontend using a deterministic LLM adapter (no real
model call). Requires Google Chrome to be installed.

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

Screenshots are written to `.context/`.

---

## Running the real agent

1. Set your API key in `.env` (see Configuration above).
2. Start the server and the Vite dev frontend in one command:

```bash
npm run dev
```

3. Open `http://localhost:5173` in your browser.

4. Type one of the following messages to process a fixture scenario:

| Message | Expected result |
|---------|----------------|
| `Process req-001` | PO created (happy path) |
| `Process req-002` | Blocked — RC1 supplier not found |
| `Process req-003` | Blocked — RC2 unauthorized approver |
| `Process req-004` | Confirmation required (RC5 quote tolerance) → confirm → PO created |
| `Process req-005` | Confirmation required (RC8 retroactive) → confirm → PO created |
| `Process req-006` | Confirmation required (RC6 derived tax code) → confirm → PO created |

Each tool call is visible as a collapsible card in the chat. The confirmation banner appears for
cases that require it; click **Confirm** to authorize the exception and create the PO.

---

## Six fixture scenarios in detail

All input files are under `fixtures/challenge-03/requests/<case>/`. They are read-only; the
application never modifies them.

| Case | Scenario | RC triggers |
|------|----------|-------------|
| req-001 | Happy path — TecnoSuministros, CC-1010, mlopez approved, 11.4 M COP | None |
| req-002 | Unknown supplier NIT 901999000 (not in master data) | RC1 blocker |
| req-003 | fvargas not authorized for CC-2020; 74 M > CC-2020 max limit (30 M) | RC2 blocker + RC3 blocker |
| req-004 | Quote total 26.5 M vs. request 25 M (+6%, threshold 2%) | RC5 confirmation |
| req-005 | Invoice date 2026-08-10 predates request date 2026-08-27 | RC8 confirmation (retroactive) |
| req-006 | No tax code or payment terms in request — both derived from supplier master | RC6 confirmation |

---

## API reference

| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| `POST` | `/api/chat` | `{ sessionId?: string, message: string, confirm?: boolean }` | `{ reply, toolCalls[], needsConfirmation, pendingConfirmation, tokenUsage, sessionId }` |
| `GET` | `/api/sessions/:id` | — | Full event history, pending confirmation state, token usage |
| `GET` | `/api/health` | — | `{ ok, provider, model }` — no API key material |

To send a human confirmation after the agent pauses:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","message":"","confirm":true}'
```

---

## Output artifacts

After each case is processed, the following files are written under `OUT_DIR` (default `./out`):

| File | Description |
|------|-------------|
| `out/<case>/approval.txt` | Canonical approval email text + SHA-256 digest |
| `out/<case>/traceability.json` | Maps every PO field to its source (`request`, `quote`, `master.*`, `derived`) |
| `out/sap/orders.jsonl` | Append-only log of created purchase orders |
| `out/control.csv` | Audit log: CREATED, BLOCKED, PENDING, IDEMPOTENT rows |
| `out/log.jsonl` | Structured tool-call log per session |

---

## Deployment

### Local production build

```bash
npm run build      # compiles TypeScript + bundles React to dist/
npm start          # starts Fastify, serving the React build as static files
```

The compiled server is at `dist/src/server.js`. Set environment variables before starting:

```bash
PORT=3000 LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-5-5 ANTHROPIC_API_KEY=sk-ant-... node dist/src/server.js
```

### Fly.io (recommended cloud deployment)

Fly.io free tier provides persistent volumes, which are required for the file-backed
`orders.jsonl`, `control.csv`, and `out/` directory. Render's free tier does not support
persistent disks.

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Create the app (first time only)
fly launch --no-deploy

# Create a 1 GB persistent volume
fly volumes create po_out --size 1 --region <region>

# Set the API key as a secret (never hardcoded)
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Set the output directory to the mounted volume
fly secrets set OUT_DIR=/data/out

# Deploy
fly deploy
```

The `fly.toml` should include:

```toml
[[mounts]]
  source = "po_out"
  destination = "/data/out"
```

On startup the server calls `repairCounter()` to restore the PO counter from `orders.jsonl`
if the counter file was lost; the order history is preserved across restarts.

**Important:** no API key is served to the browser. All LLM calls happen server-side.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Missing LLM credentials` error on startup | No API key set | Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env` |
| Agent says "I have reached the iteration limit" | Too many tool calls (unlikely with normal use) | Increase `MAX_ITERATIONS` in `.env` |
| `case not found` tool error | Fixture directory does not exist | Verify `fixtures/challenge-03/requests/<case>/` exists and has `request.json` |
| Confirmation banner does not dismiss | Session/hash mismatch | Reload the page to start a new session |
| `ENOENT out/sap/counter.txt` on first run | Normal — created automatically on first PO | No action needed; `repairCounter()` initialises the counter |
| Port 3000 already in use | Another process is running | Set `PORT=3001` in `.env` and update the Vite proxy in `web/vite.config.ts` |
| Browser acceptance tests fail with `browserType.launch` | Chrome not found | Install Google Chrome or Chromium |
| `npm run typecheck` fails with `any` errors | A type was widened | Restore strict types; do not use `as any` |
