Yes. I actually think this is the right time to slow down and build the foundation. If we do this properly, you'll have a roadmap that guides every future change instead of randomly patching bugs.

## Goal

By the end, we'll have something like:

```
docs/
└── RAG_IMPROVEMENT_BACKLOG.md
```

Every issue will follow the same format:

```md
## P0-01 People Discovery Fails

### User Problem
Users cannot ask:
- How many developers are working?
- Who works where?

### Current Behaviour
Returns "I couldn't find this in Notion."

### Expected Behaviour
Correctly identify people and count them.

### Impact
High

### Root Cause
Unknown (investigating)

### Related Files
-

### Acceptance Criteria
- [ ] "How many developers?" returns correct count.
- [ ] "List backend developers" works.
- [ ] "Who works where?" works.

Status: Open
```

Notice something important:

> **We do NOT write the root cause until we verify it from code.**

---

# Step 1 (Today)

Don't open any code.

Let's build **only the problem list**.

From everything you've shown me, I would start with these.

---

## P0 Critical

```
P0-01 People discovery fails

P0-02 Date queries fail

P0-03 Aggregation questions fail

P0-04 Follow-up conversations fail

P0-05 Task listing formatting is poor

P0-06 Page summaries are incomplete

P0-07 Smalltalk sometimes reaches RAG
```

---

## P1

```
P1-01 No answer accuracy evaluation

P1-02 Weak SQL → RAG fallback

P1-03 Weak fuzzy project matching

P1-04 Silent retrieval failures

P1-05 AI budget fallback degrades answer

P1-06 Context merge ordering
```

---

## P2

```
P2-01 Better query router

P2-02 Better confidence scoring

P2-03 Better logging

P2-04 Better benchmark

P2-05 Better analytics support
```

**Do not worry about implementation yet.**

---

# Step 2

After the backlog exists,

we pick ONE issue.

For example

```
P0-01 People discovery fails
```

Now we investigate ONLY this issue.

Questions:

```
How many developers?

↓

Intent?

↓

Lane?

↓

SQL?

↓

Metadata?

↓

Entity?

↓

Retriever?

↓

LLM?
```

Only after answering those questions do we touch code.

---

# Step 3

When P0-01 is completely understood,

then we open code.

Maybe

```
resolve-query.ts

↓

entity-resolver

↓

team-members.ts

↓

sql/activity.ts
```

Notice we're reading code with a purpose, not just browsing.

---

# Step 4

Only now do we create an implementation task.

```
Problem

↓

Root Cause

↓

Files

↓

Fix

↓

Test

↓

Done
```

---

# This is the workflow we'll follow for every issue

```
User Complaint
        │
        ▼
Create Backlog Item
        │
        ▼
Reproduce
        │
        ▼
Trace Pipeline
        │
        ▼
Find Root Cause
        │
        ▼
Read Code
        │
        ▼
Implement Fix
        │
        ▼
Add Regression Test
        │
        ▼
Close Issue
```

This is essentially how production engineering teams debug and improve complex systems.

## I suggest we start with **P0-01: People Discovery Fails** because it directly affects many user questions:

* How many developers are working?
* Who works where?
* Who is working on what?
* List frontend developers.

It will likely exercise intent classification, entity resolution, routing, SQL, and retrieval together, making it an excellent first issue to understand the pipeline. After that, the remaining issues will be much easier to tackle.
