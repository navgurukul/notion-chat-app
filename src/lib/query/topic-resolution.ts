/**
 * Shared topic ↔ Notion page title matching.
 * Used by entity resolution and SQL project scoping — prefer hubs over task tickets.
 */

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `title` is plausibly about the same topic as the user's short query. */
export function titlesReferToSameTopic(topic: string, title: string) {
  const t = topic.trim().toLowerCase();
  const row = title.trim().toLowerCase();
  if (!t || !row) return false;
  if (row === t) return true;
  if (row.startsWith(`${t} `) || row.startsWith(`${t}-`) || row.startsWith(`${t}—`)) return true;
  if (new RegExp(`\\b${escapeRegex(t)}\\b`, "i").test(title)) return true;
  return false;
}

/**
 * Rank a Notion page title for resolving a user topic (higher = better hub match).
 */
export function scoreTitleForTopic(topic: string, title: string | null | undefined): number {
  const t = topic.trim().toLowerCase();
  const row = (title ?? "").trim();
  if (!t || !row) return 0;

  const lower = row.toLowerCase();
  if (lower === t) return 10_000;

  const wordRe = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
  const hasWord = wordRe.test(row);
  const hasSubstring = lower.includes(t);
  if (!hasWord && !hasSubstring) return 0;

  let score = 600;
  if (hasWord) score += 500;
  if (hasSubstring && !hasWord && t.length > 12) score += 100;

  if (new RegExp(`^${escapeRegex(t)}(\\s|$|[-—])`, "i").test(row)) score += 250;
  if (new RegExp(`^${escapeRegex(t)}\\s+(app|mvp|prd|modes|platform|project|hub)\\b`, "i").test(row)) {
    score += 180;
  }

  score -= Math.min(row.length, 140);

  if (/^(tc-\d+|bug\b|fix\b|issue\b)/i.test(row)) score -= 400;
  if (/\b(migrate|migration|mismatch|incorrect|doesn't match|does not match|overlap|delayed|cutoff|permission|privacy policy|terms of use|figma)\b/i.test(lower)) {
    score -= 220;
  }
  if (/\[[^\]]+\]/.test(row) || /^"/.test(row)) score -= 120;
  if (/\b(transcription|keyboard|logo text|header section)\b/i.test(lower)) score -= 160;

  return score;
}

export function pickBestTitleMatch<T extends { title: string | null }>(
  topic: string,
  candidates: T[],
): T | null {
  if (!candidates.length) return null;

  const ranked = candidates
    .map((row) => ({ row, score: scoreTitleForTopic(topic, row.title) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.row.title?.length ?? 0) - (b.row.title?.length ?? 0));

  return ranked[0]?.row ?? null;
}

/** Reject canonicalization that swaps a short topic for an unrelated long task title. */
export function shouldKeepOriginalTopic(original: string, resolved: string) {
  const o = original.trim();
  const r = resolved.trim();
  if (!o || !r || o.toLowerCase() === r.toLowerCase()) return false;
  if (o.length > 32) return false;
  if (r.length <= o.length * 2) return false;
  return !titlesReferToSameTopic(o, r);
}
