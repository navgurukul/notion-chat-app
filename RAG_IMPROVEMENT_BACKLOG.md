# RAG Improvement Backlog

> **Single source of truth** for user-facing problems, root causes, acceptance criteria, and progress.

---

## Severity Guide

| Priority | Label | Definition |
|----------|-------|------------|
| **P0** | Critical | Common user workflows fail — cannot answer, returns wrong answer, hallucinates. |
| **P1** | Important | Answers are returned but are incomplete, poorly formatted, or silently incorrect. |
| **P2** | Enhancement | Architectural improvements. Not immediately user-visible but block future reliability. |

---

## P0 — Critical User Issues

---

### P0-01 People Discovery

**Status** 🟡 Partially Fixed

**User Examples**
- "How many developers are working?"
- "List all developers."
- "Who works where?"
- "Which project has the most developers?"
- "Who are all developers?"
- "How many total developers are working in NavGurukul?"

**Expected Behaviour**
Correct people should be identified, counted, and listed. Aggregation queries (count, top-N) should return numeric results, not "I couldn't find".

**Current Behaviour**
- `people_list` and `project_most_devs` intents exist in `answers.ts` and handle these specifically, but:
  - People directory (`getPeopleDirectory()` in `team-members.ts`) only surfaces users who appear as Owner, Creator, or Editor on synced pages — not all developers.
  - The intent classifier must route to `people_list`; if routing fails, these fall through to RAG which cannot count people.
- "Who works where?" has no dedicated intent mapping — may route to `assigned_list`, `owner_list`, or hang as `semantic`.

**Impact**
Users cannot get a simple headcount or roster. Trust erodes immediately since this is a basic HR/ops question.

**Likely Root Cause**
- Entity resolution pipeline (`entity-resolver/index.ts`) only resolves single-person-on-project queries, not workspace-wide people listing.
- No aggregation engine — `people_list` and `project_most_devs` are the only SQL aggregation intents, and they rely on a directory that may not reflect "currently active" developers.
- No fallback when `getPeopleDirectory()` returns empty — the bot says "No team members found" instead of suggesting a sync.

**Related Files**
- `src/lib/sql/answers.ts` — `handlePeopleList()`, `handleProjectMostDevs()`
- `src/lib/db/team-members.ts` — `getPeopleDirectory()`
- `src/lib/query/entity-resolver/index.ts` — `extractRawEntities()`
- `src/lib/query/resolve-query.ts` — intent routing
- `src/lib/query/intent.ts` — `detectIntent()`

**Acceptance Criteria**
- [ ] "How many developers are working?" returns a number (≥1) not "I couldn't find"
- [ ] "List all developers" returns a bulleted list of names
- [ ] "Which project has the most developers?" returns a project name with count
- [ ] When directory is empty, response suggests Sync changes instead of "no results"

**Test Cases**
- Single-turn: "Who are all developers?" → list of names
- Aggregation: "How many total developers?"
- Cross-project: "Which project has the most developers?"

**Notes**
- The evaluation script (`scripts/evaluate-pipeline.ts`) already tests these cases (cases 14–16). Run it to see current pass/fail.

---

### Completed ✅
- Intent routing for `people_list` (regex patterns for `List all developers.`, `Show all developers.`, `List all team members.`, `Who works where?`)
- Regex trailing punctuation handling (`\??$` → `[.?!]?\s*$`)
- "Who works where?" → `people_list` intent mapping

### Remaining □
- Verify SQL correctness — `handlePeopleList()` and `handleProjectMostDevs()` produce accurate results
- Verify developer count matches expectations
- Verify name aliases resolve correctly (e.g., "Tamanna a" → "Tamanna")
- Verify final answer accuracy end-to-end (not just intent classification)
- Add regression tests that validate final answer content, not just intent routing

---

### P0-02 Date Queries Do Not Work

**Status** ❌ Open

**User Examples**
- "Tasks between Jan 2026 and April 2026"
- "Projects updated last month"
- "Recently edited pages"
- "Current sprint"
- "This week's tasks"
- "Tasks between 2025-03-01 and 2025-06-30"

**Expected Behaviour**
Date filters should be extracted from the query and applied to the SQL/RAG retrieval — returning only results within the time window.

**Current Behaviour**
- `resolveDates()` in `entity-resolver/index.ts` handles simple relative dates (today, yesterday, this week, last week, this month, last month, this year, last year) and explicit `20XX` year mentions.
- `resolveDateRange()` in `answers.ts` duplicates the same logic for SQL layer.
- **"Between X and Y" interval queries are NOT parsed.** There is no natural language date parser (no `chrono-node`, no regex for "between Jan 2026 and April 2026").
- Date filters in RAG path only work if `parsed.year` is set — the `year` is passed to `prefetchPagesFromQuestion` via `options.year`, but month-level ranges (e.g., last month) are NOT passed to RAG retrieval. Only the SQL layer uses `dateStart`/`dateEnd`.
- "Current sprint" is not mapped to any date logic.

**Impact**
All time-scoped questions fail or return unfiltered results. Date filtering is a top-5 enterprise use case.

**Likely Root Cause**
- No date normalization layer — relative terms are parsed in two places with redundant code but no central DateNormalizer.
- Date ranges are computed but only applied in SQL `assigned_list` / `worked_on_list` / `activity_summary` handlers. RAG path ignores month-level ranges.
- "Between X and Y" is not handled anywhere.

**Related Files**
- `src/lib/query/entity-resolver/index.ts` — `resolveDates()` (partial)
- `src/lib/query/year.ts` — `extractYear()` (year-only)
- `src/lib/sql/answers.ts` — `resolveDateRange()` (duplicate of `resolveDates`)
- `src/lib/rag/build-context.ts` — `prefetchPagesFromQuestion()` (accepts year but not dateRange)
- `src/lib/query/types.ts` — `ParsedQuery.dateRange` field exists but is underused

**Acceptance Criteria**
- [ ] "Projects updated last month" returns only pages edited last month
- [ ] "Tasks between Jan 2026 and April 2026" returns only tasks in that window
- [ ] "Recently edited pages" returns recent pages with "edited" timestamps visible
- [ ] Date filter is applied in BOTH SQL and RAG paths

**Test Cases**
- Relative: "Show tasks assigned this week"
- Human interval: "Tasks between Jan 2026 and April 2026"
- Year-only: "What tasks did Tamanna work on in 2025?"
- Current contextual: "Recently edited pages"

---

### P0-03 Aggregation Questions Unsupported

**Status** ❌ Open

**User Examples**
- "How many developers?"
- "Which team has the most tasks?"
- "How many active projects?"
- "Top contributors"
- "Count of pages in status 'in progress'"
- "Which role has the most members?"

**Expected Behaviour**
Count, GROUP BY, ORDER BY, and top-N analytical queries should return structured numeric or tabular results.

**Current Behaviour**
- Only `people_list` and `project_most_devs` are supported as aggregation intents.
- "Which team has the most tasks?" — no intent for `team_task_count` or `top_n_tasks`.
- "How many active projects?" — no intent for `count_active_projects` or `status_aggregation`.
- "Top contributors" — no analytics engine; routed as `semantic` and sent to RAG, which cannot count.
- Queries like "Count of pages in 'In Progress' status" are not handled.

**Impact**
Half of all ops/manager queries involve counting or ranking. Without this, the bot cannot support management users.

**Likely Root Cause**
- No analytics routing layer — `resolveQuery()` and `detectIntent()` have no `analytics` or `aggregation` intent.
- The `METADATA_ONLY_KINDS` set in `routing-policy.ts` doesn't include aggregation intents.
- SQL answers are page-level (fetch rows, format list). No SQL aggregation (`COUNT(*)`, `GROUP BY`) is generated dynamically.
- The 13 hardcoded `PROJECT_THEMES` in `answers.ts` prevent dynamic aggregation across arbitrary categories.

**Related Files**
- `src/lib/query/intent.ts` — `detectIntent()` — no analytics intent
- `src/lib/query/resolve-query.ts` — no aggregation route
- `src/lib/chat/routing-policy.ts` — `METADATA_ONLY_KINDS` — no aggregation intents
- `src/lib/sql/answers.ts` — only `people_list`, `project_most_devs`
- `src/lib/sql/team-roster.ts` — `aggregatePeopleOnProject()` is scoped to single project

**Acceptance Criteria**
- [ ] "How many active projects?" returns a count with breakdown by status
- [ ] "Which team has the most tasks?" returns team name + count
- [ ] Aggregation intents hit SQL, not RAG
- [ ] SQL layer can execute dynamic COUNT/GROUP BY queries

**Test Cases**
- Count: "How many active projects?"
- Top-N: "Which project has the most tasks?"
- Status breakdown: "Count of pages by status"
- Filtered count: "How many pages are blocked?"

---

### P0-04 Task / Page Listing Is Poorly Formatted

**Status** ❌ Open

**User Examples**
- "List all my tasks"
- "Show pending tasks"
- "What tasks is Mahendra assigned to?"
- "Show all active projects"

**Expected Behaviour**
Tables with columns: Task Name, Status, Owner, Last Updated.

**Current Behaviour**
- SQL answers use `formatDetailedListItem()` and `formatCompactListItem()` in `format-display.ts` which output **bullet lists** with metadata inline, e.g.:
  ```
  - **Bharat FPO Finder** — assignee: Mahendra Mahendra · status: Maintaining · edited: 2026-05-06
  ```
- No table rendering anywhere in the answer pipeline.
- Markdown tables (`| Task | Status | Updated |`) would be more scannable.

**Impact**
Users get verbose paragraphs instead of scannable tables. For users with >5 tasks, the output is hard to read.

**Likely Root Cause**
- `formatRows()` in `answers.ts` uses `formatDetailedListItem()` which was designed for rich context but not for quick scanning.
- No table formatter exists in `format-display.ts`.
- The response is returned as plain text/JSON — there's no post-processing step that could render tables.

**Related Files**
- `src/lib/sql/format-display.ts` — `formatDetailedListItem()`, `formatCompactListItem()`
- `src/lib/sql/answers.ts` — `formatRows()`
- `src/lib/chat/pipeline.ts` — answer is returned as-is from `trySqlAnswer()`

**Acceptance Criteria**
- [ ] "List all my tasks" returns a markdown table with Task, Status, Updated columns
- [ ] "What tasks is Mahendra assigned to?" returns a table
- [ ] Table format adapts to number of results (compact for many rows)
- [ ] No regression on cases where paragraph format is better (e.g., project_summary)

**Test Cases**
- 1–5 tasks: table with all columns
- 6+ tasks: compact table
- Mixed intents: `activity_summary` may still benefit from paragraphs; `assigned_list` should be table

---

### P0-05 Follow-Up Questions Break Context

**Status** ❌ Open

**User Examples**
```
User: Who owns Oscar?
Bot: Souvik owns Oscar MVP.
User: What else is he working on?
Bot: [fails or returns unrelated]
```

```
User: What tasks is Mahendra assigned to?
Bot: List of tasks...
User: When was it updated?
Bot: [loses entity reference]
```

**Expected Behaviour**
Pronouns ("he", "she", "it", "they", "this task") resolve to entities from the immediately preceding conversation turn.

**Current Behaviour**
- `reformulateSearchQuery()` in `query-reformulation.ts` uses LLM to rewrite follow-ups. This is good when it works but:
  - **Timeouts**: LLM call has 2500ms timeout (`resolve-query.ts` line ~108). On timeout, fallback is `buildContextualSearchQuery()` in `history.ts` which is a simple concatenation.
  - **Heuristic extraction path**: `extractLastEntityFromHistory()` in `router.ts` uses regex over bold/backtick/link markup from bot responses. If the bot didn't bold the entity name (e.g., answer was "Souvik owns Oscar MVP" with markup only around the answer structure, not around "Souvik"), extraction fails.
  - **DB session state** (`activePerson`, `activeProject`) is saved but only updated on certain conditions (confidence ≥ 0.7 for person, hardcoded source for project). If confidence is low, state is not updated → follow-up loses context.
  - **Pronoun resolution** in `resolvePronouns()` only resolves "he/him/his" and "she/her" from `lastPerson`. It does NOT resolve "it/this/that" to `lastProject`. The `lastProject` is not used in pronoun resolution at all.
  - **"When was it updated?"** — "it" should resolve to last mentioned task/project. The pronoun resolver only handles person pronouns.

**Impact**
Multi-turn dialogue breaks after 1–2 turns. Users must restate full entity names, defeating the purpose of a conversational interface.

**Likely Root Cause**
- Pronoun resolution is person-only (3rd person pronouns). Entity resolution for objects ("it", "this task", "that project") is missing.
- `extractLastEntityFromHistory()` depends on fragile markup parsing rather than tracking the last-mentioned entity from the intent/answer structure.
- Session state persistence has conditional save logic that may skip entity updates.
- LLM reformulation timeout (2500ms) is aggressive for complex follow-ups.

**Related Files**
- `src/lib/chat/query-reformulation.ts` — `reformulateSearchQuery()`
- `src/lib/chat/pipeline/router.ts` — `extractLastEntityFromHistory()`, `resolvePronouns()` (not present here — actually in `entity-resolver/index.ts`)
- `src/lib/query/entity-resolver/index.ts` — `resolvePronouns()` (person-only)
- `src/lib/chat/pipeline.ts` — session state saving logic (lines ~150–180)
- `src/lib/chat/history.ts` — `buildContextualSearchQuery()` (fallback)
- `src/lib/query/resolve-query.ts` — LLM timeout (line ~108)

**Acceptance Criteria**
- [ ] "Who owns Oscar?" → "What else is he working on?" returns Souvik's other projects
- [ ] "What tasks is Mahendra assigned to?" → "When was it updated?" returns the task's edit date
- [ ] "Tell me about Employee Onboarding Hub" → "Who owns it?" returns the owner
- [ ] Context survives SQL→RAG boundary (SQL answer followed by RAG follow-up)

**Test Cases**
- Multi-turn: Person→pronoun→project→pronoun chain (4+ turns)
- SQL→RAG: "Status of Oscar" → "Tell me more about it" → RAG summary with context
- Correction: "No, I meant Sanjana" → resolves correctly

---

### P0-06 Smalltalk Routed to Notion

**Status** ❌ Open

**User Examples**
- "Today's date"
- "Hello"
- "Thanks"
- "What time is it?"
- "Ok"
- "Nice job"
- "Tell me a joke"

**Expected Behaviour**
These should be answered immediately without hitting Notion DB or RAG.

**Current Behaviour**
- Greeting thanks bye identity howAreYou help are detected by `detectSmalltalkType()` in `router.ts` via specific regex patterns.
- Date/time utility bypass exists via `utilityDateTimeRegex` in `pipeline.ts` — but only for specific phrases like "today's date", "current time".
- **Gaps:** "Ok", "nice job", "tell me a joke", "good morning" (lowercase), "how are you today?" (with extra words) are NOT matched by the regex patterns.
  - `greetingRegex`: `^(hi|hello|hey|greetings|good\s+morning...)$/i` — anchors at `^...$` so "how are you today?" doesn't match.
  - `SMALLTALK_HEURISTIC` in `resolve-query.ts` covers more but still misses "nice job", "ok" as standalone.
  - When smalltalk regex fails, the message continues through the full pipeline: intent classification → entity resolution → SQL attempt → RAG. This wastes tokens and returns "I couldn't find this in Notion".

**Impact**
Users perceive the bot as rude or broken for basic social interactions. Smalltalk consuming pipeline latency and LLM calls wastes AI budget.

**Likely Root Cause**
- Smalltalk regex patterns in `router.ts` are too narrow (`^...$`).
- The `SMALLTALK_HEURISTIC` in `resolve-query.ts` is a second layer but still misses common short utterances.
- No catch-all "short utterance = smalltalk" heuristic (e.g., if message < 4 words and contains no Notion keywords).
- The test suite (`scripts/evaluate-pipeline.ts`) lists "tell me a joke" and "nice job" as expected smalltalk (cases 35, 36), suggesting these are known failures.

**Related Files**
- `src/lib/chat/pipeline/router.ts` — `detectSmalltalkType()`, regex patterns
- `src/lib/query/resolve-query.ts` — `SMALLTALK_HEURISTIC` regex
- `src/lib/chat/pipeline.ts` — fast-path routing, date/time utility regex
- `scripts/evaluate-pipeline.ts` — test cases 29–38

**Acceptance Criteria**
- [ ] "nice job" returns a smalltalk response (no Notion lookup)
- [ ] "tell me a joke" returns a smalltalk response
- [ ] "ok" returns a smalltalk response (or ack)
- [ ] Date/time queries always bypass Notion retrieval
- [ ] Zero LLM calls for any of these

**Test Cases**
- All greeting variations: "hi", "hello", "hey there", "good morning"
- Acknowledgments: "ok", "okay", "thanks", "ty", "nice job", "great"
- Identity: "who are you?", "what is your name?"
- Time: "what time is it?", "current time", "today's date"
- Smalltalk that should NOT route: "tell me about Oscar" (has entity)

---

### P0-07 Page Summaries Incomplete

**Status** ❌ Open

**User Examples**
- "Tell me more about PDF Widget Rendering"
- "Give me an overview of Oscar project"
- "Summarize the Employee Onboarding Hub"

**Expected Behaviour**
Response should include: description/body, subtasks/related pages, owner, status, links to related pages, key dates.

**Current Behaviour**
- For `project_summary` intent: `buildProjectSummary()` in `answers.ts` returns hub page title, status, owner, body (1200 chars max), related pages list, status counts. This is reasonable but:
  - Body is limited to 1200 chars — may truncate important context.
  - Related pages are listed as bullets with minimal metadata (status, owner only).
  - No subtask extraction.
  - No links are rendered inline if the answer goes through the streaming path (RAG).
- For RAG path (`page_about`): `buildNotionContextWithConfidence()` retrieves chunk context + prefetch pages. The context assembly (`assembleChatContext`) puts prefetch first, then semantic chunks. However:
  - The LLM prompt does not explicitly instruct the model to include description, subtasks, owners, links, and related pages.
  - The AI budget fallback (`buildRetrievalOnlyAnswer()`) returns only title + status + owner + 320-char snippet — very sparse.
- When AI budget is hit, `buildRetrievalOnlyAnswer()` returns a preview-only response that lacks depth.

**Impact**
Users asking for summaries get metadata snippets, not actual content. This is the core RAG use case and it fails to deliver value.

**Likely Root Cause**
- No structured summary prompt template — the LLM receives raw context and answers freely; no guidance to include specific sections.
- `buildProjectSummary()` is a SQL-only path that doesn't use vector retrieval for body text.
- AI budget fallback (`shouldUseAiBudget()` in `ai-budget.ts`) triggers a preview-only answer with no detail.
- `buildRetrievalOnlyAnswer()` uses only DB page preview (title, status, owner, 320-char snippet) — no chunk context.

**Related Files**
- `src/lib/sql/answers.ts` — `buildProjectSummary()`
- `src/lib/rag/build-context.ts` — `assembleChatContext()`, `buildRetrievalOnlyAnswer()`
- `src/lib/shared/ai-budget.ts` — `shouldUseAiBudget()`
- `src/lib/chat/pipeline/rag.ts` — streaming answer call

**Acceptance Criteria**
- [ ] "Summarize Oscar project" returns: description, owners, status, related pages with links, risks/blockers
- [ ] "Tell me more about PDF Widget Rendering" returns full body (not truncated to 320 chars)
- [ ] AI budget mode still returns useful summary, not "I can't answer"
- [ ] Summary includes clickable Notion links

**Test Cases**
- SQL project_summary: "Summarize Oscar project" → structured answer
- RAG page_about: "Tell me about Employee Onboarding Hub" → full summary with links
- AI budget path: simulate budget exhausted → verify preview quality

---

## P1 — Pipeline Issues

---

### P1-08 No Answer-Level Evaluation

**Status** ❌ Open

**User Examples** (developer-facing)
- "Is the answer factually correct?"
- "Does the answer match the ground truth from Notion?"

**Current Behaviour**
- `scripts/evaluate-pipeline.ts` validates: lane routing, intent classification, entity resolution, retrieval recall@5.
- **Does NOT validate:** Whether the final generated answer (SQL response or LLM-generated text) is factually correct against ground truth.
- `src/lib/chat/answer-quality.ts` only checks if SQL answer is a "miss" (`isSqlMissAnswer()`) or if it should fall back to RAG (`shouldFallbackToRag()`). It doesn't evaluate answer correctness.

**Impact**
Impossible to measure true QA accuracy. Pipeline improvements may improve routing scores while degrading answer quality, and no test catches it.

**Likely Root Cause**
- Ground truth dataset doesn't exist (no curated Q/A pairs with expected answer text).
- Evaluating LLM-generated answers requires an LLM judge (expensive, complex) or exact-match against known facts.
- The team prioritized routing accuracy over answer accuracy — reasonable for building phase but must be addressed now.

**Related Files**
- `scripts/evaluate-pipeline.ts` — evaluation framework
- `src/lib/chat/answer-quality.ts` — only miss detection
- `src/lib/chat/pipeline/rag.ts` — streaming path
- `src/lib/chat/pipeline/sql.ts` — JSON answer path

**Acceptance Criteria**
- [ ] Evaluation framework includes answer-level correctness check
- [ ] At least 20 question/ground-truth-answer pairs exist
- [ ] Answer accuracy is reported as a metric

**Test Cases**
- Ground truth: Q="What is the status of Oscar MVP?", A="In Development"
- Pipeline answer must match within tolerance

---

### P1-09 Fragile SQL → RAG Fallback

**Status** ❌ Open

**User Examples**
- Short correct SQL answers are sent to RAG unnecessarily (wasteful, may hallucinate).

**Current Behaviour**
- `shouldFallbackToRag()` in `answer-quality.ts` uses length-based heuristics:
  - `assigned_list` with `personName` and answer length < 120 chars → fallback to RAG.
  - `project_eta` with `isWeakProjectEtaAnswer()` (checks for "No explicit completion date").
  - `page_about` with "pages matching" in answer.
  - All `project_summary` and `topic_list` kinds fallback always.
- This is brittle: a correct but short answer (e.g., "No tasks found") triggers RAG fallback, which may hallucinate.

**Impact**
Users get slower responses (RAG path takes 2–5s) and potentially hallucinated answers when the correct answer was already available from SQL.

**Likely Root Cause**
- Fallback thresholds (`< 120 chars`) are guesses, not derived from data.
- No semantic confidence check — just length + keyword heuristics.
- No per-kind calibration (e.g., "owner_of" with a 10-char answer is fine; "assigned_list" with 50 chars may be incomplete).

**Related Files**
- `src/lib/chat/answer-quality.ts` — `shouldFallbackToRag()`
- `src/lib/chat/pipeline/sql.ts` — calls `shouldFallbackToRag()`

**Acceptance Criteria**
- [ ] Correct SQL answers < 120 chars are NOT sent to RAG
- [ ] Known incomplete SQL answers still fall back to RAG
- [ ] Fallback decision is logged and measurable

**Test Cases**
- Short correct: "Who owns Oscar?" → "Souvik" (10 chars) → stays SQL
- Short incomplete: "Tasks for Mahendra" → 0 results → RAG fallback

---

### P1-10 Weak Fuzzy Project Matching

**Status** ❌ Open

**User Examples**
- "datapivots" should match "DataPivot AI"
- "Zuvy v2" should match "Zuvy App"

**Current Behaviour**
- `deriveCoreTerm()` in `build-context.ts` strips known suffixes (`ai|app|platform|project|tool|system|service|v\d+|mvp|beta|poc`).
- This is hardcoded to specific suffixes. Unseen patterns (e.g., "Zuvy Eval", "ReportList Pro", "Oscar backend") are not handled.

**Impact**
Pages with project names that don't match the hardcoded suffix patterns are not found via fuzzy fallback.

**Likely Root Cause**
- The fuzzy matching is a hack added to fix specific edge cases (DataPivot AI → DataPivot). Not a general solution.
- No trigram similarity matching, no Levenshtein distance, no stemming.
- The `FUZZY_STRIP_SUFFIX` regex is regex-based, not data-driven.

**Related Files**
- `src/lib/rag/build-context.ts` — `deriveCoreTerm()`, `FUZZY_STRIP_SUFFIX`
- `src/lib/sql/project-scope.ts` — `filterPagesForProjectTopic()`

**Acceptance Criteria**
- [ ] "datapivots" matches "DataPivot AI" page
- [ ] "Zuvy v2" matches "Zuvy App" page
- [ ] "oscar mvp" matches "Oscar MVP" page
- [ ] Matching does not produce false positives for unrelated pages

**Test Cases**
- Singular/plural: "DataPivot" ↔ "DataPivots AI"
- Suffix variants: "Zuvy" ↔ "Zuvy App" ↔ "Zuvy Eval"
- Acronym/hyphen: "ReportList" ↔ "Report-List"

---

### P1-11 Silent FTS Failures

**Status** ❌ Open

**User Examples** (developer)
- FTS query silently fails, no error logged.

**Current Behaviour**
- In `prefetchPagesFromQuestion()` in `build-context.ts`, the FTS query block is wrapped in a bare `try/catch` with no logging:
  ```ts
  try {
    // plainto_tsquery query...
  } catch {
    // LIKE results above are enough
  }
  ```
- Exceptions are swallowed entirely — no console.warn, no telemetry.

**Impact**
FTS failures are invisible. If the FTS index is corrupted or a query syntax fails, the system silently degrades to LIKE-only matching without anyone noticing.

**Likely Root Cause**
- Developer treating FTS as optional enhancement, so failures were considered acceptable.
- No observability infrastructure for per-stage query failures.

**Related Files**
- `src/lib/rag/build-context.ts` — FTS catch block (lines ~215–225)

**Acceptance Criteria**
- [ ] FTS failures are logged with the failing query and error message
- [ ] Telemetry captures FTS failure count
- [ ] LIKE fallback continues to work

**Test Cases**
- Trigger FTS with special characters that break `plainto_tsquery` → verify error is logged
- Verify FTS returns normally for clean queries

---

### P1-12 AI Budget Fallback Reduces Answer Quality

**Status** ❌ Open

**User Examples**
- Normal question gets a preview-only response when budget is exhausted.

**Current Behaviour**
- `buildRetrievalOnlyAnswer()` in `build-context.ts` returns only title + status + owner + 320-char snippet.
- This happens when `shouldUseAiBudget()` returns true in `ai-budget.ts`.
- The response says: "I'm returning the strongest matches without generating a full AI answer to stay within the AI budget."

**Impact**
Users perceive the bot as giving incorrect/incomplete answers. The budget message sounds like a technical limitation, not a helpful response.

**Likely Root Cause**
- The AI budget feature was designed to control costs, but the fallback is too sparse.
- No hybrid fallback: e.g., if budget is low, use a cheaper model (Gemini Flash → Haiku) or a shorter prompt rather than skipping generation entirely.

**Related Files**
- `src/lib/rag/build-context.ts` — `buildRetrievalOnlyAnswer()`
- `src/lib/shared/ai-budget.ts` — `shouldUseAiBudget()`

**Acceptance Criteria**
- [ ] AI budget fallback returns a useful summary, not "no full AI answer"
- [ ] Fallback message does not mention "AI budget" to end users
- [ ] Budget limits are configurable per-query (not binary)

**Test Cases**
- Simulate budget exhausted → verify answer is still substantive
- Verify budget-respecting path is logged

---

### P1-13 Context Merge Ordering

**Status** ❌ Open

**User Examples**
- LLM prompt has less relevant context before more relevant context.

**Current Behaviour**
- `assembleChatContext()` in `build-context.ts` puts prefetch (DB page text) FIRST, then semantic chunks SECOND:
  ```
  ## Synced Notion pages (from database)
  [prefetch...]
  ---
  ## Additional excerpts (search index)
  [semantic chunks...]
  ```
- Prefetch is keyword/LIKE/FTS based — may contain less relevant pages.
- Semantic chunks are vector/MMR ranked — more relevant.
- LLM prompt context is limited — if prefetch consumes most of the context window, higher-relevance semantic chunks get truncated or excluded.

**Impact**
Less relevant context dominates the prompt, potentially causing hallucination or omission of key facts.

**Likely Root Cause**
- Developer assumption that "DB pages first" is natural. No relevance-based sort.
- Prefetch is formatted as full page sections (title, metadata, body) while semantic chunks are snippets — prefetch naturally uses more tokens.

**Related Files**
- `src/lib/rag/build-context.ts` — `assembleChatContext()`

**Acceptance Criteria**
- [ ] Context sections are ordered by relevance (semantic first, or interleaved by score)
- [ ] Token budget per section is configurable
- [ ] Combined context fits within model context window

**Test Cases**
- Measure context token distribution: prefetch vs semantic
- Verify top-3 semantic chunks appear in first 50% of context

---

## P2 — Architectural Improvements

---

### P2-14 No Explicit Query Router

**Status** ❌ Open

**Description**
The pipeline has no explicit routing layer. Today, routing is spread across:
- Regex checks in `resolve-query.ts` (smalltalk, link, ambiguous)
- Intent classifier (`resolveQuery()` → `classifyQueryIntent()`)
- `trySqlAnswer()` / `tryRagAnswer()` in pipeline files

There's no single `route(query) → { lane, context }` function.

**Need**
```
Question
  ↓
Intent Detection
  ↓
Router
  ↓
  ├─ Chat (smalltalk)
  ├─ SQL (metadata)
  ├─ RAG (semantic)
  ├─ Analytics (COUNT / GROUP BY)
  ├─ Date / Time (utility)
  ├─ Link (Notion URL)
  └─ Hybrid (SQL + RAG merged)
```

**Related Files**
- `src/lib/chat/pipeline.ts` — current sequential routing
- `src/lib/query/resolve-query.ts` — intent + entity resolution
- `src/lib/chat/pipeline/router.ts` — partial routing (smalltalk regex)

---

### P2-15 No Analytics Execution Engine

**Status** ❌ Open

**Description**
Need support for:
- `COUNT(*)` with filters
- `GROUP BY` with aggregation
- `ORDER BY` with `LIMIT`
- `FILTER` by status/person/project/date

Currently only `people_list` and `project_most_devs` are hardcoded. A generic analytics engine would:
1. Parse "count of X grouped by Y" from the query
2. Generate SQL `SELECT COUNT, GROUP BY, ORDER BY`
3. Return tabular results

**Related Files**
- `src/lib/sql/answers.ts` — only pre-written aggregation queries
- `src/lib/query/types.ts` — `ParsedQuery` has no `analytics` fields

---

### P2-16 No Date Normalizer

**Status** ❌ Open

**Description**
Date handling is duplicated across:
- `entity-resolver/index.ts` — `resolveDates()`
- `sql/answers.ts` — `resolveDateRange()` (identical logic)

Missing:
- "Between X and Y" interval parsing (e.g., "between Jan 2026 and April 2026")
- "Current sprint" → date range (needs sprint config or Notion database)
- Quarter-based: "Q1 2026", "this quarter"
- Week number: "week 14 of 2026"
- Ordinal: "3rd week of January"

A single `DateNormalizer` class should:
1. Parse all relative/absolute date expressions into `{ dateStart, dateEnd }`
2. Be used by both SQL and RAG layers
3. Have test coverage

**Related Files**
- `src/lib/query/entity-resolver/index.ts` — `resolveDates()`
- `src/lib/sql/answers.ts` — `resolveDateRange()`
- `src/lib/query/year.ts` — `extractYear()`

---

### P2-17 No Confidence-Based Clarification

**Status** ❌ Open

**Description**
When entity resolution is ambiguous (e.g., "Anirudh" matches "Anirudh Bansal" and "Anirudh Kalukula"), the bot asks for clarification. This already works for people (`resolvePerson()` returns `ambiguous: true` + `candidates`).

Missing:
- **Document ambiguity**: "Oscar" matches "Oscar MVP", "Oscar mobile app", "Oscar — Architecture" → should ask "Which Oscar page did you mean?"
- **Date ambiguity**: "last month" could mean calendar month or last 30 days → should ask
- **Project vs page**: "Tell me about Oscar" → "Do you want the project summary (Oscar MVP) or a specific page?"
- **Confidence thresholds**: Below 0.7 confidence, ask for confirmation

**Related Files**
- `src/lib/query/entity-resolver/person.ts` — `resolvePerson()` (has ambiguity for people)
- `src/lib/query/entity-resolver/document.ts` — `resolveDocument()` (no ambiguity support)
- `src/lib/chat/pipeline/sql.ts` — handles person ambiguity with clarifying question

---

## Progress Summary

| Priority | Total | Open | In Progress | Resolved |
|----------|-------|------|-------------|----------|
| **P0** | 7 | 7 | 0 | 0 |
| **P1** | 6 | 6 | 0 | 0 |
| **P2** | 4 | 4 | 0 | 0 |
| **Total** | **17** | **17** | **0** | **0** |

