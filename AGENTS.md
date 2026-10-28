# Repository Agent Instructions — Periferia Challenge 03

Read `PRD.md` completely, then `IMPLEMENTATION_BRIEF.md`, and inspect all fixture inputs before making edits. The PRD is authoritative. Start by planning: do not implement until the plan is approved by the user.

Do not modify files under `fixtures/`. Keep mandatory tool contracts, RC1..RC10 and demo requirements exact. Business validation, confirmation authorization and SAP creation must be deterministic backend logic, not controlled by the LLM. Revalidate before writing; do not trust model-supplied `confirmed` flags. Keep API keys private. Keep `out/` and `.env` out of commits.

Work in small, verifiable phases. Write tests against each official case before treating a feature as finished. Run actual checks and report observed evidence. Do not falsely claim that deployment, live-model interactions or tests passed.

Use TypeScript without `any`, Zod schemas, typed errors, and minimal dependencies. Defer P1 and bonus features until all mandatory P0 behavior works. Document assumptions and AI use honestly in `SOLUTION.md`.
