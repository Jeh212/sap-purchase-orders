# Technical challenge 03 — "SAP Purchase Orders" conversational agent

> Selection process · Perxia 2.0 Team · Periferia IT Group
> Version 2.0 · 2026-09-03 · Document handed to the candidate at the start of the session

---

## 0. Challenge sheet

| Item | Definition |
|---|---|
| **Duration** | Communicated at the start of the session. |
| **Challenge** | Build a **complete, standalone conversational agent** that automates the preparation and creation of purchase orders in SAP: chat interface, backend with the agent loop and its tools, and a connection to a language model. It must be testable from a link. |
| **Language** | TypeScript (Bun or Node 20+) for the backend and tools. Front end of your choice: React, Svelte, Vue or plain HTML. |
| **Language model** | Whichever you choose (Anthropic, OpenAI, Google, Azure, Mistral, local). The key is yours. It is read from an environment variable and **never** appears in the repository, the front end or the logs. |
| **AI allowed** | Any AI assistant to build (Claude, ChatGPT, Gemini, Copilot, Cursor, etc.). You must **declare which ones you used and for what** in `SOLUTION.md`. You must be able to explain every line you deliver. |
| **What you do NOT receive** | Code from, or access to, any Periferia product. The challenge is standalone: it is solved with the attached fixtures and this document. |
| **Deliverable** | Repository with the application, a link to test it, a `demo.ts` that runs the tools without a model, and a `SOLUTION.md` describing the solution approach. See section 9. |
| **Bonus** | Up to +10 points if you also deliver the agent packaged as a reusable module (section 9.4). |
| **Pass mark** | 70 / 100 points according to the rubric in section 10. |

---

## 1. Executive summary

Every purchase at Periferia reaches the administrative area by email with three pieces: an Excel request, the supplier's quote and the manager's approval email. The analyst manually keys into SAP the supplier, description, cost center and subarea, amount, tax code, approver and payment terms, and attaches the approval email converted to PDF. This is repeated for every invoice that comes into the company.

The challenge is to build an agent that **reads the package, validates it against the master data (suppliers, cost centers, approval matrix, tax codes, payment terms), builds the PO payload, generates the approval evidence PDF and creates the PO in a simulated SAP**. Exceptions are not forced through: they are classified and returned to the human with a recommendation.

One finding about the current process is that many POs are created **after** the invoice arrives, skipping the quote. The agent must detect that case and flag it, because management wants to measure it.

---

## 2. Context and problem

### 2.1 Current situation (as-is)

| Dimension | Today |
|---|---|
| Input | Email with `request.xlsx` + `quote.pdf` + the manager's approval email. |
| Data entry | Supplier, description, cost center, subarea, amount, tax code, approver, payment terms. Manual, in SAP GUI. |
| Evidence | The approval email is printed to PDF and attached to the PO. |
| Frequency | One per incoming invoice. |
| Process deviation | The PO is often created after the invoice is received. The quote is skipped. |
| Integration | The feasibility of connecting to SAP is not confirmed. |

### 2.2 Pain we solve

1. **Time**: repetitive data entry with a high cost of error (a mistyped cost center is corrected at accounting close).
2. **Control**: validating that the approver is allowed to approve that amount in that cost center is done mentally, not systematically.
3. **Measurement**: nobody knows what percentage of POs are retroactive.

### 2.3 What this challenge does NOT solve

- Real connection to SAP (RFC, OData, IDoc). It is designed, not implemented.
- Reading binary Excel and PDF files: the fixtures provide the request as JSON and the quote as text. Reading a real `.xlsx` is an optional P1.
- Goods receipt, invoice posting or payment.

---

## 3. Goals and non-goals

### 3.1 Goals

| # | Goal | Success metric in the challenge |
|---|---|---|
| G1 | Eliminate data entry in the normal flow. | Case `req-001` ends with a PO created in the simulated SAP without human intervention. |
| G2 | Block whatever fails controls. | `req-002` (nonexistent supplier) and `req-003` (approver without authority) do **not** create a PO and return the reason and the suggested action. |
| G3 | Turn doubts into confirmations, not silent errors. | `req-004` (quote ≠ request) and `req-006` (tax code not provided) ask for confirmation before creating. |
| G4 | Measure the process deviation. | `req-005` (invoice earlier than the request) is created only with confirmation and is flagged `retroactive = true` in the control log. |

### 3.2 Non-goals

- User authentication, roles or multi-user support.
- Database persistence. The simulated SAP writes to files.
- Approval workflow (the manager already approved by email; the agent verifies, it does not request).

---

## 4. Users and actors

| Actor | Role in the flow | Interaction with the agent |
|---|---|---|
| **Requester** | Needs to buy something. | Sends the package by email. Does not use the agent. |
| **Approving manager** | Approves the expense. | Replies to the email with "Approved". Does not use the agent. |
| **Administrative analyst** (primary user) | Creates the PO in SAP. | Chats with the agent: "process request X". Confirms exceptions. |
| **Accounting / Audit** | Controls the spending. | Consumes the control log (`out/control.csv`). |
| **SAP** | System of record. | Simulated by the local adapter. |

---

## 5. User stories and acceptance criteria

### US-1 · Read the package
**As an** analyst, **I want** the agent to read the email, the request, the quote and the approval, **so that** I have the data in one place.

Acceptance criteria:
- `po_read_package` returns `{ email, request, quote, approval, invoice? }` normalized according to section 7.2.
- A missing attachment is reported as `null` with the name of what is missing; no exception is thrown.

### US-2 · Validate against master data and controls
**As an** analyst, **I want** the agent to check everything I currently check from memory, **so that** I do not create invalid POs.

Acceptance criteria:
- `po_validate` applies all the rules in section 7.3 and returns `{ eligible: boolean, blockers[], confirmations[], derived{} }`.
- `blockers` prevent creating the PO. `confirmations` allow it only with `confirmed = true`. `derived` are values the agent completed from the master data (for example, the supplier's payment terms) and must report.

### US-3 · Build the payload
**As an** analyst, **I want** to see the PO exactly as it would look in SAP before creating it, **so that** I can review it at a glance.

Acceptance criteria:
- `po_build_payload` produces the object in section 7.4, valid against its `zod` schema.
- Every value in the payload is traceable to a source: `request`, `quote`, `master.<name>` or `derived`. The traceability is saved in `out/<case>/traceability.json`.

### US-4 · Generate the approval evidence
**As** audit, **I want** the approval email as a PDF attached to the PO, **so that** the expense is supported.

Acceptance criteria:
- **P0**: `out/<case>/approval.txt` with headers (from, to, date, subject), body and the `sha256` of the content.
- **P1**: `out/<case>/approval.pdf` with the same content (`pdf-lib` or similar).

### US-5 · Create the PO in the simulated SAP
**As an** analyst, **I want** the agent to create the PO and give me the number, **so that** I can close the case.

Acceptance criteria:
- `po_create` only runs if `eligible = true` and (`confirmations` is empty **or** `confirmed = true`).
- The simulated adapter assigns a sequential number starting at `4500000001`, writes to `out/sap/orders.jsonl` and returns `{ po_number, date }`.
- Creating the same `request_id` twice returns the existing number (idempotency), not a second PO.
- Every attempt (successful, blocked or pending) adds a row to `out/control.csv`: `request_id, result, po_number, retroactive, blockers, confirmations, ts`.

### US-6 · Error handling
- Incomplete package, malformed JSON, non-numeric amount: readable `{ ok: false, error }`. The agent reports it and suggests what to ask the requester for.

---

## 6. Required architecture

You are building an end-to-end conversational agent. You are free to choose the framework, but not the shape: these components and this tool contract are mandatory, because they are what we evaluate.

### 6.1 Components

```
┌──────────────┐  HTTP / WS   ┌─────────────────────────────────────────┐
│  Front: chat │ ───────────▶ │  Backend                                │
│  - history   │ ◀─────────── │  - agent loop (prompt → model →         │
│  - tool calls│              │    tool calls → response)               │
│  - confirm   │              │  - typed tools (zod)                    │
└──────────────┘              │  - LLM provider adapter                 │
                              │  - sessions in memory or file           │
                              └───────┬─────────────────────┬───────────┘
                                      │                     │
                               fixtures/ (read only)     out/ (write)
```

| Component | Mandatory | Detail |
|---|---|---|
| **Chat front end** | Yes | Conversation history, input field, "thinking" indicator. It must **show every tool call** (name, arguments, summarized result) and **highlight when the agent asks for confirmation**. Streaming optional. |
| **Backend** | Yes | Exposes the chat API. Runs the agent loop with an iteration cap. Keeps the session (memory or file). |
| **Tools** | Yes | Functions typed with `zod`, separated from the HTTP server and importable from `demo.ts`. They are the **only** source of values the agent can assert. |
| **LLM adapter** | Yes | Your own interface (`send(messages, tools) → response`) with an implementation for the provider you choose. Switching providers must not touch the agent loop. |
| **System prompt** | Yes | In a separate Markdown file (`agent/prompt.md`), not embedded in code. |
| **Persistence** | No | Memory or files in `out/` are enough. No database. |
| **Authentication** | No | The link can be public. If you protect it, provide the access key in the README. |

### 6.2 Tool contract

Each tool is an object with three members. The name the model sees is `<file>_<export>`.

```ts
// src/tools/po.ts
import { z } from "zod"

export const read_package = {
  description: "…one sentence: it is the only thing the model reads to decide when to call it",
  args: {
    case_id: z.string().describe("Name of the case folder in fixtures/challenge-03/requests/")
  },
  async execute(args: { case_id: string }, ctx: { directory: string; sessionId: string }) {
    // ctx.directory = project root; resolve paths from here, never absolute
    return JSON.stringify({ ok: true, data: { /* ... */ } })
  },
}
```

| Member | Rule |
|---|---|
| `description` | One precise sentence. |
| `args` | Object of `zod` schemas with `.describe()` on every field. The backend validates before executing and returns the error to the model if it does not comply. |
| `execute(args, ctx)` | Returns a **string** (serialized JSON) with `{ ok: true, data }` or `{ ok: false, error }`. **Never throws.** |

Minimum contract for this challenge:

| Tool | Input | Output (`data`) | Priority |
|---|---|---|---|
| `po_read_package` | `{ case_id }` | Normalized package (7.2) | P0 |
| `po_validate` | `{ case_id, package }` | `{ eligible, blockers[], confirmations[], derived, retroactive }` | P0 |
| `po_build_payload` | `{ case_id, package, derived }` | `PurchaseOrder` (7.4) + traceability path | P0 |
| `po_generate_evidence` | `{ case_id }` | `{ path, sha256 }` | P0 txt · P1 pdf |
| `po_create` | `{ case_id, payload, confirmed?: boolean }` | `{ po_number, date, idempotent: boolean }` or `{ ok: false, error }` | P0 |
| `po_read_excel` | `{ path }` | `{ rows[] }` | Optional P1 |

### 6.3 Agent loop rules

| # | Rule |
|---|---|
| AL1 | Cap on tool → model iterations per turn (suggested 25). When it is reached, the agent responds with what it has and what is missing. |
| AL2 | The model **cannot assert a value** that did not come from a tool. The prompt forbids it; the design makes it unnecessary. |
| AL3 | **Human confirmation**: when an action requires it, the agent ends the turn with an explicit question. It only proceeds if the user's next message confirms. The front end highlights that state. |
| AL4 | Every tool call is recorded in the visible chat history and in `out/log.jsonl`. |
| AL5 | A tool or LLM provider error is shown in the chat in plain language. The session does not die. |

### 6.4 Minimum API

Free design, but documented in the README. Reference:

| Method | Path | Body / response |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` (or an event stream) |
| `GET` | `/api/sessions/:id` | Full session history |
| `GET` | `/api/health` | `{ ok: true, provider, model }` without exposing keys |

### 6.5 Suggested repository structure

```
challenge-03/
├── agent/
│   └── prompt.md                        # agent system prompt
├── src/
│   ├── server.ts                        # HTTP API and agent loop
│   ├── llm/
│   │   ├── adapter.ts                   # provider interface
│   │   └── <provider>.ts                # chosen implementation
│   ├── tools/
│   │   └── po.ts                        # tools (each export → po_<export>)
│   └── sap/
│       ├── adapter.ts                   # SapAdapter interface (given in 7.4)
│       └── mock.ts                      # file-based implementation
│   └── knowledge/
│       └── purchase-orders.md           # process knowledge the agent consults
├── web/                                 # chat front end
├── fixtures/                            # provided by Periferia (do not modify)
├── out/                                 # generated at runtime
├── demo.ts                              # tools without a model
├── .env.example                         # required variables, without values
├── package.json
├── README.md
└── SOLUTION.md
```

Separation we evaluate: **behavior** in `agent/prompt.md`, **knowledge** in `src/knowledge/`, **execution** in `src/tools/`. A change in business rules should not touch the server.

### 6.6 `demo.ts` (model-free verification)

Processes the 6 cases in `fixtures/challenge-03/requests/` by calling the tools directly. It prints per case: `eligible`, blockers, confirmations, `retroactive`, PO number or reason. It must show idempotency by running `req-001` twice and an explicit confirmation for `req-004`. It must run without a key from any provider:

```bash
bun install && bun run demo.ts
```

---

## 7. Detailed functional requirements

### 7.1 Fixtures

| Path | Content |
|---|---|
| `fixtures/challenge-03/requests/<case>/email.json` | `{ id, from, subject, date, body, attachments[] }`. |
| `.../request.json` | Normalized Excel request: `{ request_id, requester, supplier_name, supplier_tax_id?, description, cost_center, subarea, quantity, unit_price, total_value, currency, tax_code?, payment_terms?, request_date }`. Fields with `?` may be missing. |
| `.../quote.txt` | Text of the quote: supplier, tax ID (NIT), items, subtotal, VAT, total, validity. |
| `.../approval.json` | `{ from, to, date, subject, body }`. The body may or may not contain the word "Approved". |
| `.../invoice.txt` | Only in the retroactive case: invoice dated earlier than `request_date`. |
| `fixtures/challenge-03/master-data/suppliers.json` | `{ sap_code, tax_id, name, default_payment_terms, default_tax_code, active }[]`. |
| `fixtures/challenge-03/master-data/cost-centers.json` | `{ cost_center, subareas[], approvers: [{ email, limit }] }[]`. |
| `fixtures/challenge-03/master-data/tax-codes.json` | `{ code, description, rate }[]`. |
| `fixtures/challenge-03/master-data/payment-terms.json` | `{ code, description, days }[]`. |

### 7.2 Normalized package

```ts
type Package = {
  email: { id: string; from: string; subject: string; date: string }
  request: Request                     // see 7.1
  quote: { supplier: string; tax_id: string | null; total: number; currency: string; valid_until: string | null; text: string } | null
  approval: { from: string; date: string; approved: boolean; text: string } | null
  invoice: { number: string; date: string; total: number } | null
}
```

### 7.3 Control rules

| # | Rule | Type |
|---|---|---|
| RC1 | The supplier must exist in `suppliers.json` (by tax ID; if there is no tax ID, by normalized name) and be `active`. | **Blocker** |
| RC2 | The approval must exist, contain "Approved" and come from an email listed as an approver for the `cost_center`. | **Blocker** |
| RC3 | `total_value` ≤ the approver's `limit` for that cost center. | **Blocker** |
| RC4 | `subarea` must belong to the `cost_center`. | **Blocker** |
| RC5 | `abs(quote.total − request.total_value) / request.total_value` ≤ 2 %. If exceeded: confirmation with both values. If there is no quote: confirmation. | Confirmation |
| RC6 | `tax_code` missing → derived from the supplier (`default_tax_code`) and confirmation is requested. | Confirmation + derived |
| RC7 | `payment_terms` missing → derived from the supplier. Informational only. | Derived |
| RC8 | There is an `invoice` with `date` < `request_date` → `retroactive = true`. Confirmation. Recorded in the control log. | Confirmation |
| RC9 | The approval date must be ≥ `request_date`. If not: confirmation. | Confirmation |
| RC10 | `quantity × unit_price` must equal `total_value` (± 1 monetary unit). If not: blocker. | **Blocker** |

### 7.4 PO payload and SAP adapter

Simplified schema inspired by the SAP purchase order API. It must be validated with `zod`:

```ts
type PurchaseOrder = {
  reference: { request_id: string; email_id: string; quote_ref: string | null }
  company_code: "1000"
  purchasing_org: "1000"
  supplier: { sap_code: string; tax_id: string; name: string }
  currency: "COP" | "USD"
  payment_terms: string                // code, e.g. "Z030"
  approver: { email: string; approval_date: string; evidence_sha256: string }
  items: Array<{
    number: number                     // 10, 20, 30...
    description: string                // max. 40 characters (SAP short text limit)
    quantity: number
    unit: "EA" | "H" | "MON"
    unit_price: number
    cost_center: string
    subarea: string
    tax_code: string                   // code, e.g. "C1"
  }>
  exceptions: Array<{ code: string; detail: string; confirmed_by: string | null }>
}
```

Adapter interface (mandatory in `src/sap/adapter.ts`):

```ts
export interface SapAdapter {
  lookupSupplier(tax_id: string): Promise<{ sap_code: string; active: boolean } | null>
  createOrder(order: PurchaseOrder): Promise<{ po_number: string; date: string }>
  findOrderByReference(request_id: string): Promise<{ po_number: string } | null>
}
```

`src/sap/mock.ts` implements it on top of `out/sap/`. In `SOLUTION.md` you design the real implementation (see 7.5).

### 7.5 Required design (documentation only) — real SAP adapter

In `SOLUTION.md`, describe:
- Which integration option you would choose (OData `API_PURCHASEORDER_PROCESS_SRV`, RFC/BAPI `BAPI_PO_CREATE1`, SAP Integration Suite, or file upload) and why, given an unconfirmed feasibility.
- How you map the payload from 7.4 to the real chosen structure.
- Authentication and where the credentials live (never in the agent or in the prompt).
- Idempotency in the face of retries and what you do if SAP responds with a partial error.
- Plan B if the connection is not feasible: how the agent still saves time (for example, by generating the PO ready to paste or a bulk upload file).

---

## 8. Non-functional requirements

| Category | Requirement |
|---|---|
| Startup | One command brings up the front end and backend locally (`bun run dev` or `docker compose up`). Less than 2 minutes on a clean machine with the variables from `.env.example`. |
| Determinism | `demo.ts` produces the same result in consecutive runs (except timestamps). `out/` is cleaned at startup. |
| Security | Model key only in a backend environment variable. Never in the front end, the repository, the logs or the API responses. No real credentials or personal data. Tools do not execute shell commands. |
| Cost | Configurable cap on iterations per turn and on tokens per session. A user cannot spend your key without limit. |
| Robustness | Typed errors `{ ok: false, error }`. Timeout to the LLM provider with a clear message. One bad case does not prevent the next one. |
| Readability | TypeScript without `any`, short functions, consistent names. |
| Dependencies | Whatever you need, justified in `SOLUTION.md`. `zod` is mandatory for tool arguments. |

---

## 9. Deliverable and documentation

### 9.1 `SOLUTION.md` — mandatory structure

1. **The problem in one sentence** and who it hurts.
2. **Architecture**: front end → backend → tools → files diagram, and where the prompt, the knowledge and the execution live.
3. **Agent loop**: how you implemented the loop, the iteration cap and human confirmation.
4. **Model choice**: provider, model, why, and estimated cost per processed case.
5. **Control matrix**: how you implemented RC1–RC10 and which one was the hardest.
6. **Real SAP adapter design** (section 7.5).
7. **Process reading**: in half a page, what you would tell management about retroactive POs and what process change you would propose.
8. **Decisions and trade-offs**: at least 3, with the discarded alternative and why.
9. **Assumptions** you made when interpreting this PRD.
10. **Coverage**: table of user stories with status (done / partial / not done) and what is missing for production.
11. **Use of AI**: which assistants you used to build, for which tasks, what you discarded from what they proposed and why.
12. **Risks** of taking this to production and how you would mitigate them.

### 9.2 `README.md`

How to run locally (one command), required environment variables, how to run `demo.ts`, the test link and, if applicable, the access key for the link.

### 9.3 Test link

Public URL where the agent responds (Vercel, Render, Fly.io, Railway, Azure, a stable tunnel, or the provider you prefer). It must be live during the defense. If deployment was not possible, running it locally during the defense is accepted with a `-10` penalty.

### 9.4 Bonus: reusable module (up to +10)

Also deliver a `module/` folder with the agent packaged to integrate into other agent platforms, without depending on your server:

```
module/
├── agent.md            # frontmatter: description, mode: primary, permission {edit: deny, bash: deny}; body: the system prompt
├── tools/po.ts     # the same tools, importable without the server
└── skill/purchase-orders/SKILL.md   # frontmatter: name, description; body: the process knowledge
```

We evaluate that the three pieces are the same ones your application uses (not divergent copies).

### 9.5 How to deliver

Git repository with commit history, or `challenge-03-<lastname>.zip`. No `node_modules/`, no `out/`, no `.env`.

---

## 10. Risks, assumptions and open questions

| Type | Content |
|---|---|
| Assumption | The master data in the fixtures is complete. In production it is queried in SAP in real time. |
| Assumption | The approval email is sufficient evidence. Audit may require a digital signature. |
| Risk | The connection to SAP may not be feasible in the short term. Mitigation: Plan B from section 7.5. |
| Risk | The model "fixes" an amount so it matches the quote. Mitigation: amounts come from the tools; the model cannot alter the validated payload. |
| Open question | Who decides the policy on retroactive POs: tolerate them with a flag, or reject them? Out of scope for the challenge; the agent measures them. |

---

## 11. Sample prompt for the demo

In your chat, new session:

```
Process the request "req-004". Show me the PO as it would look in SAP, which
validations it passed and which ones it did not, and do not create it until I
confirm.
```

Expected result: Payload summarized in a table, list of confirmations with both values (request vs quote), visible tool calls, and a question closing the turn. After "I confirm", the PO number and the path to the evidence.
