# Testing Restructure Plan

## Steps

- [x] Step 1: Create `scratch/regressions/` directory with separate regression files
  - [x] `scratch/regressions/people-intent.json`
  - [x] `scratch/regressions/people-answers.json`
  - [x] `scratch/regressions/dates.json` (placeholder)
  - [x] `scratch/regressions/aggregation.json` (placeholder)
- [x] Step 2: Update `scratch/people-regression.json` — rename `intent` → `expectedIntent`, remove `"semantic"` intents
- [x] Step 3: Update `src/lib/query/rules.ts` — add reusable keyword groups (`PEOPLE_WORDS`, `LIST_WORDS`)
- [x] Step 4: Create `scratch/verify-intents.ts`
- [x] Step 5: Create `scratch/verify-answers.ts`
- [x] Step 6: Create `scratch/verify-performance.ts`

