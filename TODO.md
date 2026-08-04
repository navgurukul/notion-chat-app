

- [x] Step 5: Add current-message analysis before falling back to `lastEntities`
- [x] Step 6: Only inject `lastPerson` when query has pronouns or explicit follow-up markers
- [x] Step 7: Improve `isFollowUpQuery()` precision

## Bug 3: P0-03 — Grouped project-member aggregation fails
**Files:** `src/lib/query/types.ts`, `src/lib/query/rules.ts`, `src/lib/sql/answers.ts`, `src/lib/chat/routing-policy.ts`

- [x] Step 8: Add `project_member_breakdown` QueryKind to types
- [x] Step 9: Add regex patterns in rules.ts
- [x] Step 10: Add handler in answers.ts
- [x] Step 11: Add to METADATA_ONLY_KINDS in routing-policy.ts
- [x] Step 12: Update RAG_IMPROVEMENT_BACKLOG.md

