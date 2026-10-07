export type SqlResult =
  | { status: "hit"; answer: string }
  | { status: "miss"; answer: string }                 
  | { status: "unresolved"; reason: "person" | "page" } 
  | { status: "gap" };                                 

export const hit = (answer: string): SqlResult => ({ status: "hit", answer });
export const miss = (answer: string): SqlResult => ({ status: "miss", answer });
export const unresolved = (reason: "person" | "page"): SqlResult => ({ status: "unresolved", reason });
export const gap = (): SqlResult => ({ status: "gap" });

export function classifySqlAnswer(answer: string | null | undefined): SqlResult {
  if (!answer?.trim()) return gap();
  if (isSqlMissAnswer(answer)) return miss(answer);
  return hit(answer);
}

/** SQL response that is an explicit empty/miss, not a substantive metadata answer. */
export function isSqlMissAnswer(answer: string): boolean {
  const lower = answer.trim().toLowerCase();

  if (
    lower.includes("couldn't find") ||
    lower.includes("not found in synced") ||
    lower.includes("no synced notion") ||
    lower.includes("no tasks or pages found") ||
    lower.includes("no assignee found") ||
    lower.includes("no project data found") ||
    lower.includes("do not list people as owner") ||
    lower.includes("not listed as the owner") ||
    lower.includes("doesn't appear to work") ||
    lower.startsWith("no.") ||
    lower.startsWith("no matching result") ||
    lower.startsWith("could not find")
  ) {
    return true;
  }

  // Structured SQL answers may mention Sync changes as a footnote, not as a miss.
  if (/^#{2,3}\s+/m.test(answer.trim()) && answer.trim().length > 180) return false;

  return false;
}