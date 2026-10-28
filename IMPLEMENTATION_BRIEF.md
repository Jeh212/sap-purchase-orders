# Conductor Implementation Brief — Challenge 03: SAP Purchase Orders Agent

**Project:** Periferia IT Group — Perxia 2.0 technical assessment 03  
**Objective:** Deliver a fully functioning, end-to-end conversational agent, aiming for complete compliance with the official requirements and maximizing assessment quality.  
**Primary specification:** `PRD.md` (authoritative).  
**Fixture directory:** `fixtures/challenge-03/` (read-only, authoritative input).  
**Language:** TypeScript, Node.js 20+; React + Vite; Fastify; Zod; Vitest.  
**Execution mode:** **PLAN FIRST. DO NOT IMPLEMENT ANY CODE UNTIL THE PLAN IS REVIEWED AND APPROVED BY THE USER.**

## 0. Your assignment: research the repository before proposing solutions

Read ALL of `PRD.md`, inspect every supplied fixture including all six requests and all master-data files, and inspect the current repository. Do not treat this brief as a substitute for the PRD. If the repository already contains working TypeScript/React/LLM infrastructure, identify what can be safely reused rather than rebuilding it. Do not invent APIs, models, fields or acceptance criteria. Where this brief and the PRD disagree, the PRD wins; document any discrepancy.

Before writing code, produce a **reviewable implementation plan** that includes:

1. Requirements traceability table: official user stories US-1..US-6, controls RC1..RC10, agent rules AL1..AL5, mandatory tools and their success/error contracts, non-functional requirements and deliverables.
2. Proposed repository layout, key modules and type definitions; explicit data flow and trust boundaries.
3. Dependency list and rationale; choose the **smallest implementation** that fulfills P0.
4. Phase-by-phase tasks with files to create/change, acceptance criteria, commands to verify and dependencies between phases.
5. A six-case expected-results matrix, plus negative/security/edge cases, including assertions on output files and idempotency.
6. Risk register ranked by impact and likelihood; distinguish mandatory P0 requirements from optional P1/bonus features.
7. Deployment design for a **live public URL**, including the LLM provider configuration and writable filesystem limitations.
8. An explicit **Definition of Done** with executable evidence, not just implementation claims.
9. A short list of genuine PRD ambiguities and the conservative assumptions you will document in `SOLUTION.md`. Avoid blocking questions if they can be resolved safely from the fixtures.

Suggested plan destination when approved: `docs/IMPLEMENTATION_PLAN.md`. In Plan Mode, present the plan for approval before changing source code or running destructive commands. Do not mark tasks DONE based on unexecuted tests or simulated outputs.

## 1. Product outcome and hard requirements

The administrative analyst says `Process req-001` (or another fixture ID) in a web chat. The agent:

1. Reads the email, JSON request, supplier quote, approval and optional invoice through `po_read_package`.
2. Validates against supplier, cost-center, approval, payment-term and tax master data through `po_validate` and RC1..RC10.
3. Reports blockers, confirmations and derived values honestly and clearly; **blocks invalid orders**.
4. Generates verifiable approval evidence with SHA-256.
5. Builds a schema-valid, traceable SAP PO payload. The final payload contains the evidence SHA-256.
6. For cases requiring human consent, shows the reason, ends the conversation turn and waits for the user's explicit next-turn confirmation.
7. Calls `po_create` only when permitted. The simulated SAP creates the PO or returns the original one for repeated request IDs.
8. Shows the final PO number, audit information and trace/evidence paths in the UI.

The result must include a real chat frontend, an actual model-backed tool-calling agent loop, a functioning backend and simulated SAP, a standalone model-free `demo.ts`, a working public URL, `README.md`, `SOLUTION.md`, and safe configuration. Do **not** replace the model with a regex/chat mock in the production chat route. Do **not** implement a real SAP connection.

## 2. Required architecture (simple, testable and auditable)

```text
React + Vite chat
  -> Fastify /api/chat, /api/sessions/:id, /api/health
  -> Agent loop (bounded iterations / timeout / token budget)
  -> LLM adapter (OpenAI Responses API or other verified provider)
  -> Zod-validated tools in src/tools/po.ts
     -> pure domain validation / trusted fixtures (read-only)
     -> evidence and traceability artifacts (out/)
     -> SapAdapter in src/sap/adapter.ts
     -> deterministic filesystem mock in src/sap/mock.ts
```

Mandatory source-of-truth separation:

- `agent/prompt.md`: agent behavior, decision policy, tool usage and prohibition on invented facts.
- `src/knowledge/purchase-orders.md`: process knowledge; business semantics; exception explanations.
- `src/tools/po.ts`: deterministic Zod tools; no tool business decisions delegated to the LLM.
- `src/domain/`: recommended pure normalization, rules, schemas, payload helpers.
- `src/llm/adapter.ts`: provider-neutral adapter, not coupled to HTTP/routes.
- `src/sap/adapter.ts` and `src/sap/mock.ts`: mandatory interface and mock implementation.
- `web/`: chat with visible tool calls, history, thinking state and highlighted confirmation requests.
- `demo.ts`: uses the actual tool implementations with no LLM key.

Keep domain logic testable without starting the HTTP server or calling an LLM. Avoid databases, queues, OCR, RAG, authentication, or unnecessary distributed architecture. No `any` in TypeScript source.

## 3. Tool contracts (names and exact behavior are mandatory)

Every tool exported from `src/tools/po.ts` uses the contract `{ description, args: { field: z.schema.describe(...) }, execute(args, ctx) }`; the visible name is `po_<export>`. The backend validates the input with Zod. Each `execute` returns **a JSON string** that encodes either `{ ok: true, data }` or `{ ok: false, error }`, never throws uncaught errors.

- `po_read_package({ case_id })`: normalized `{ email, request, quote, approval, invoice? }`, with missing optional attachments as `null` and explicit missing-attachment metadata.
- `po_validate({ case_id, package })`: `{ eligible, blockers, confirmations, derived, retroactive }`. `eligible` must mean no blockers; confirmation can still be pending. Never trust the model-supplied package as the authority: compare with or reconstruct from original fixtures.
- `po_build_payload({ case_id, package, derived })`: builds the exact Zod validated `PurchaseOrder` from PRD 7.4, writing `out/<case>/traceability.json`; use authoritative validated data, not untrusted model edits.
- `po_generate_evidence({ case_id })`: generates `out/<case>/approval.txt`, with from/to/date/subject/body and a content SHA-256; returns evidence path/hash. Ensure the hash is defined unambiguously over the canonical content **excluding the hash annotation itself**. Optional `approval.pdf` only after P0 passes.
- `po_create({ case_id, payload, confirmed? })`: **re-validate RC1..RC10 and the authoritative payload on the server side**. Do not accept model-written `confirmed: true` as proof of human confirmation. Require a session-scoped, explicit human confirmation for the exact request/proposed payload or implement an equivalently secure mechanism that is testable. Return PO number/date/idempotent on success; on failure a typed error and appropriate control log entry. Implement atomic/idempotent behavior under retries.

Critical ordering: `po_generate_evidence` must run **before finalizing `po_build_payload`**, because `PurchaseOrder.approver.evidence_sha256` is mandatory. Document this ordering in the plan.

No path traversal: `case_id` must be constrained to an existing case folder inside the fixture root. Always resolve within the trusted project directory. Never write inside `fixtures/`.

## 4. RC1..RC10: deterministic control requirements

Implement every rule from PRD 7.3. Summary:

- RC1 **blocker**: supplier exists by normalized tax ID or (if ID missing) normalized name and is active.
- RC2 **blocker**: approval exists, contains `Approved`, and sender is an authorized approver for the **requested cost center**.
- RC3 **blocker**: approved amount is at or below that approver's cost-center-specific limit.
- RC4 **blocker**: subarea belongs to cost center.
- RC5 **confirmation**: no quote, or quote total exceeds a ±2% tolerance of request total. Show both values and divergence percentage.
- RC6 **confirmation + derived**: tax code missing; derive from supplier, show it to user and require confirmation.
- RC7 **derived only**: payment terms missing; derive from supplier and inform user.
- RC8 **confirmation**: invoice exists and is dated before the request; set `retroactive=true` and record it.
- RC9 **confirmation**: approval timestamp is before request date.
- RC10 **blocker**: `quantity * unit_price` does not match total within ±1 monetary unit.

Validate that referenced tax codes and payment terms actually exist in their corresponding master files; never fabricate fallback values. Be explicit in assumptions if the PRD does not define a given missing/invalid-field policy.

Handle Latin American formatting, currency, quoted `TOTAL` values and text dates accurately. The quote contains a NIT with a verification suffix (for example `900.555.111-2`), whereas the supplier master stores the base tax ID (`900555111`); normalize correctly without confusing it with the buyer's tax ID. The quote text contains multiple monetary totals, so extract the final **VAT-included TOTAL**, not taxable base, VAT amount or line subtotal. Preserve `COP` and `USD` semantics; avoid locale-dependent floating-point comparisons.

## 5. Six official case oracles — tests MUST assert these

| Case | Expected validation & action |
|---|---|
| `req-001` | Eligible, no blockers, no confirmations, PO created normally. On second attempt, exact same PO number and `idempotent=true`, with no duplicate SAP row. |
| `req-002` | Unknown supplier. RC1 blocker; no PO, useful remediation message. |
| `req-003` | Approver is associated with a different cost center. RC2 blocker and possibly other independently valid blockers; no PO, despite an `Approved` email. |
| `req-004` | Request COP 25,000,000 vs quote COP 26,500,000 (+6%). RC5 confirmation; no creation until explicitly confirmed; preserve approved request amount in PO, do not silently replace it with quote amount. |
| `req-005` | Invoice dated 2026-08-10 predates request dated 2026-08-27; `retroactive=true`; RC8 confirmation and control log flag. A quote IS present: do not mark it missing. |
| `req-006` | Missing tax code, supplier tax ID and payment terms. Supplier resolved by normalized name, tax code `C1` derived with confirmation, payment terms `Z030` derived without extra confirmation. No creation until explicit confirmation. |

Do not hard-code outcomes by case ID. The same domain rules must produce these outcomes from the fixture contents. Make errors understandable and suggestions actionable.

## 6. Simulated SAP, files, consistency and auditability

`SapAdapter` interface is mandatory (`lookupSupplier`, `createOrder`, `findOrderByReference`), as defined in PRD 7.4.

- First PO number: `4500000001`; subsequent PO numbers sequential.
- Write one immutable record per created order to `out/sap/orders.jsonl`.
- `request_id` is the idempotency key, including under concurrent attempts; design serialization/locking or equivalent protection appropriate to file persistence.
- `out/control.csv` records **every creation attempt** (successful, blocked and pending) with exactly the expected column semantics: `request_id,result,po_number,retroactive,blockers,confirmations,ts`. Escape fields correctly for CSV.
- `out/<case>/traceability.json` identifies the provenance of every mandatory PO field: `request`, `quote`, `master.<name>` or `derived` (plus an evidence provenance explanation for the approval hash).
- `out/<case>/approval.txt` includes a reproducible digest of canonical approval content and required email metadata.
- `out/log.jsonl` records tool calls with name, arguments (sensitive fields redacted) and summarized results, correlated to session/case.
- No supplied fixture may be modified. Generated `out/` artifacts and `.env` should be gitignored.
- Tests/demo must have a clearly documented **repeatable reset** that does not destructively wipe a live user's data unexpectedly. Use isolated output for tests whenever possible.

## 7. LLM / human-in-the-loop correctness

- Choose one working LLM provider with function calling; use `LLM_PROVIDER`, `LLM_MODEL`, and appropriate server-side credentials. Never expose keys in logs, API responses or frontend assets.
- Build a genuine bounded agent loop: model -> tool calls -> validated execution -> results -> model, with an iteration cap (suggested 25), configurable token budget and provider timeout. Report partial failure to the user without killing the session.
- Conversation state must survive multiple turns in the same session; `GET /api/sessions/:id` exposes safe history and visible tool events.
- Present a structured confirmation pending state for the current case and proposed payload. A user message such as `I confirm` must explicitly authorize the **same** pending request, not another case or arbitrary values. A tool call is not a human confirmation.
- Never allow `po_create` when validation has blockers. For outstanding confirmations require user authorization and include confirmed exception metadata (`code`, `detail`, `confirmed_by`) in the PO.
- Frontend displays the user message, agent messages, tools' names/arguments/summarized results, loading/thinking, highlighted confirmations, final result and recoverable errors. Avoid deceptive progress indicators.
- Add rate limiting appropriate to a public demo, maximum message length and path restrictions. Never allow arbitrary commands/file reads through model-facing tools.

## 8. Model-free demo and quality gates

`demo.ts` must call the **actual tools** directly; it must run without an LLM API key. It must process all six cases and print their `eligible`, blockers, confirmations, `retroactive`, PO number (or reason). Explicitly re-run `req-001` to assert idempotency, and simulate a distinct trusted human confirmation for `req-004` before creating. Repeatability matters: same business results over consecutive runs, except timestamps.

Minimum automated tests:

1. Each RC1..RC10, happy and negative paths, plus all six official fixtures.
2. Missing attachment, malformed request JSON, invalid numeric value, unknown case ID and `../` traversal attempt.
3. Quote parsing (correct total, VAT, base NIT, validity), accent/case name normalization, date timezone handling, amount tolerance exact boundary (2%), invalid master references.
4. Schema validation for full PO, 40-character item description limit, company/purchasing code, currency and item numbering.
5. Evidence SHA integrity and traceability for all mandatory fields.
6. Create-once idempotency, repeated attempt, concurrent creation race, sequential numbering and audit-row consistency.
7. Confirmations cannot be bypassed using forged tool args or a confirmation from another case/session.
8. Agent loop: proper function/tool-call correlation, iteration cap, timeout, token cap, clear provider errors and provider-independent demo.
9. API integration test of `/api/chat`, `/api/sessions/:id` and `/api/health`, plus a **real-provider** smoke test when a key is available.
10. End-to-end UI smoke test for `req-001` auto-create, `req-002` blocked and `req-004` user confirmation, preferably in a browser; log exactly what was actually run.

Quality commands should be provided in `package.json` with deterministic non-watch outputs, for example: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run demo`, `npm run build`, `npm run dev`. Adjust tooling to the chosen package manager consistently. Preserve the PRD-required `bun run demo.ts` pathway if feasible; otherwise document and justify the equivalent.

Do not claim 100% correctness based solely on unit tests. Verify live LLM interaction and public link separately.

## 9. Expected planning phases and gates (plan must expand these)

**Phase 0 — Specification audit & fixture characterization.** Map US/RC/AL, analyze fixtures, define acceptance test matrix and unresolved assumptions. Gate: every P0 requirement has an owner and test.

**Phase 1 — Core scaffolding & contracts.** Initialize TypeScript, Fastify, React, Zod, tests; define domain schemas, tool contract and SapAdapter. Gate: all scripts run; no dead code dependencies.

**Phase 2 — Normalization & policy engine.** Implement read/parse and pure rules RC1..RC10. Gate: all official cases produce expected blockers/confirmations/derived results without LLM.

**Phase 3 — Artifacts & SAP mock.** Implement SHA evidence, traceability, payload, atomic idempotent create and audit control files. Gate: outputs inspectable; req-001 duplicate returns same PO.

**Phase 4 — Agent loop & LLM adapter.** Implement real tool calls, system prompt, knowledge file, state machine, limits and session history. Gate: actual model operates safely, with error recovery.

**Phase 5 — Frontend.** Build clean chat with visible calls, confirmation state and result details. Gate: analyst can complete full flow on UI.

**Phase 6 — Demo & integration tests.** Add `demo.ts`, edge/security tests, end-to-end scenarios. Gate: repeatable runnable commands; failures fixed, not hidden.

**Phase 7 — Documentation & live deployment.** Write `README.md`, full 12-section `SOLUTION.md`, provider/cost assumptions, real SAP adapter design (OData/BAPI/etc.), realistic risks, AI tools disclosure, deployment URL. Gate: clean install + live functional end-to-end verification.

**Phase 8 — Optional, only after all P0 gates pass.** Evidence PDF, XLSX ingestion, reusable `module/` bonus using the same prompt, tools and knowledge sources (no duplicate divergent implementations).

Prefer small coherent commits after each gate. Put distinct, independent tasks into separate workspaces only if merge/coordination cost stays low; the validation/tool contracts should be established before agents work in parallel.

## 10. Mandatory documentation and final handoff

`SOLUTION.md` must include the **12 sections** specified in official PRD 9.1, including architecture, loop, model choice and realistic per-case cost, full RC matrix, real SAP integration option + authentication + retries/idempotency + partial errors + plan B, retroactive POs process impact, ≥3 documented trade-offs, assumptions, user-story coverage, detailed disclosure of AI tools used and risks to production.

`README.md` must explain local one-command startup, `.env.example`, non-model demo, tests, and public test link. `out/` and secrets stay out of Git. Do not falsely claim production-grade SAP integration or that public deployment works if it has not been verified.

## 11. Definition of Done — don't sign off without evidence

The solution is complete only after:

- Every mandatory user story, RC, tool contract and agent-loop rule is traced to implemented code and executable verification.
- Six official fixtures match their expected behaviors, plus `req-001` idempotency and `req-004` explicit user confirmation.
- A blocker or missing consent cannot be bypassed by malformed/crafted LLM tool arguments.
- Correct `orders.jsonl`, `control.csv`, `traceability.json`, `approval.txt` and `log.jsonl` are actually generated and inspected.
- Real model integration demonstrably calls tools, returns grounded answers and recovers from provider failure.
- Chat UX, single-command local startup, `demo.ts` without credentials and public URL all work.
- `typecheck`, tests, build and relevant lint checks pass on the final branch. Report test counts/results from command outputs, not estimates.
- All documentation and disclosures are accurate; no credentials, `node_modules/`, `out/` or modified fixtures in the submitted repository.

**First response required from the coding agent:** present the Phase 0 findings and the full phased implementation plan, explain the top five quality risks, identify exactly which files will be created, and request approval **before implementation**. Do not begin coding yet.
