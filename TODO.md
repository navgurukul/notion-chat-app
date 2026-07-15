## TODO - Hybrid Option C (Variation Pool + LLM Warm-Reply)

- [ ] Update `src/lib/chat/pipeline/router.ts`
  - [x] Add `userName?: string` support
  - [x] Replace fixed smalltalk strings with 3–5 variation pools per smalltalkType
  - [x] Export smalltalk detection helper (`detectSmalltalkType`)
  - [x] Add helper to build smalltalk reply (pool + personalization)

- [ ] Update `src/lib/chat/pipeline.ts`
  - [ ] Add repeat detection based on `history` user messages only
  - [ ] Maintain per-type counters within recent user history
  - [ ] If repeat threshold hit (3rd+), call LLM warm-reply (try/catch) and fallback to variation pool
  - [ ] Ensure logic applies for BOTH:
    - [ ] fast-path regex smalltalk path
    - [ ] non-fastpath LLM-classified smalltalk path

- [ ] Ensure session saving behavior remains correct
  - [ ] Use existing DB writes (`addChatMessage`) via existing `jsonAnswer` or existing fast-path saving

- [ ] Testing checklist
  - [ ] Run lint/build
  - [ ] Manual: send "hi" 3–4 times in one session
  - [ ] Manual: simulate warm-reply failure and confirm fallback
  - [ ] Manual: verify name personalization

