# P0-01: People Discovery Fix

## Checklist

- [x] Step 1-2: Traced the pipeline — identified root causes
- [x] Step 3: Plan confirmed with user

## Implementation

- [x] Fix `rules.ts`: Update `people_list` regex to accept trailing punctuation (`.`, `!`)
- [x] Fix `rules.ts`: Add "Who works where?" pattern → `people_list`
- [x] Verify TypeScript compiles (only pre-existing errors in other files)
- [x] Run test queries to verify fixes — **11/11 passed**
- [x] Close issue

## Fixes Applied

### 1. `rules.ts` — people_list regex trailing punctuation
**Change:** `\??$` → `[.?!]?\s*$`  
**Root cause:** Regex broke when user typed period at end (e.g. "List all developers.")

### 2. `rules.ts` — "Who works where?" handler  
**Change:** Added new pattern matching `/^who\s+works\s+where/` and `/^who\s+works?\s+on\s+what/`  
**Root cause:** No pattern matched this query → fell through to `semantic` → gave "I couldn't find this in Notion."

