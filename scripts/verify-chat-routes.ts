/**
 * Offline routing regression table (no DB, no OpenAI).
 * Run: npm run verify:chat-routes
 */
import { shouldFallbackToRag, isSqlMissAnswer } from "@/lib/chat/routing-policy";
import type { ParsedQuery } from "@/lib/query/types";

type Quality = "EXACT" | "PREFIX" | "PARTIAL";
const pq = (kind: string, o: Partial<{ page: Quality; title: string; person: string }> = {}): ParsedQuery => ({
  kind,
  docTitle: o.title,
  personName: o.person,
  resolvedEntities: o.page ? { page: { value: o.title ?? "X", quality: o.page } } : undefined,
} as unknown as ParsedQuery);

const STRUCT = "### Team for Oscar\n\n- **Priya** — Owner\n- **Rahul** — Assignee\n- **Anita** — Captain\n\n[Open in Notion](https://notion.so/abc)";
const OWNER_HIT = '**Owner/assignee of "Oscar":** Priya\n\n[Open in Notion](https://notion.so/abc)';

const cases: Array<[string, ParsedQuery, string | null, boolean]> = [
  ["owner_of exact hit stays SQL", pq("owner_of", { page: "EXACT", title: "Oscar" }), OWNER_HIT, false],
  ["owner_of prefix hit stays SQL", pq("owner_of", { page: "PREFIX", title: "Oscar" }), OWNER_HIT, false],
  ["owner_of fuzzy hit -> RAG", pq("owner_of", { page: "PARTIAL", title: "completed" }), OWNER_HIT, true],
  ["owner_of null -> RAG", pq("owner_of", { page: "EXACT", title: "Leave Policy" }), null, true],
  ["owner_of miss msg -> RAG", pq("owner_of", { title: "Leave Policy" }), "No synced Notion page matched **Leave Policy** for an owner lookup.", true],
  ["assigned_list long miss -> RAG", pq("assigned_list", { person: "Tamanna" }), "No tasks or pages found assigned to **Tamanna** in synced Notion data. Try **Sync changes** or rephrase with a year, e.g. tasks assigned to Tamanna in 2025.", true],
  ["activity_summary miss -> RAG", pq("activity_summary", { person: "Tamanna" }), "No activity or project assignment data found for **Tamanna** in synced Notion. Check name spelling or **Sync changes**.", true],
  ["missing-entity msg -> RAG", pq("activity_summary"), "No person name found for activity lookup.", true],
  ["team_roster structured hit stays SQL", pq("team_roster", { title: "Oscar" }), STRUCT, false],
  ["project_list structured hit stays SQL", pq("project_list"), STRUCT, false],
  ["project_most_devs hit stays SQL", pq("project_most_devs"), STRUCT, false],
  ["membership 'No.' -> RAG verify", pq("assignee_project_check", { person: "Priya", title: "Oscar" }), "No. Priya doesn't appear to work on Oscar.", true],
  ["membership 'Yes' stays SQL", pq("person_project_membership", { person: "Priya", title: "Oscar" }), "Yes. **Priya** is listed on **Oscar** (Owner).", false],
  ["team_activity metadata gap -> RAG", pq("team_activity", { title: "Oscar" }), "Ranking is not available from metadata alone for Oscar.", true],
  ["status_of exact hit stays SQL", pq("status_of", { page: "EXACT", title: "Oscar" }), "**Status of Oscar:** In progress\n\n[Open in Notion](https://notion.so/abc)", false],
  ["analytics (no SQL handler) -> RAG", pq("analytics"), "Some answer", true],
  ["project_summary -> RAG", pq("project_summary", { title: "Oscar" }), "Summary...", true],
  ["semantic -> RAG", pq("semantic"), null, true],
];

let failed = 0;
for (const [name, parsed, sql, expected] of cases) {
  const got = shouldFallbackToRag(parsed, sql);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (expected ${expected}, got ${got})`);
}

for (const real of [STRUCT, OWNER_HIT, "Yes. **Priya** is listed on **Oscar**."]) {
  if (isSqlMissAnswer(real)) {
    failed++;
    console.log("FAIL  real answer flagged as miss:", real.slice(0, 40));
  }
}

if (failed) {
  console.error(`\n${failed} routing check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} routing checks passed`);
