export type ResolvedPersonEntity = {
  value?: string | null;
  confidence: number;
  ambiguous?: boolean;
  candidates: string[];
  rawInput?: string;
};

export function buildClarificationAnswer(
  resolvedPerson?: ResolvedPersonEntity | null,
  rawNameOrMessage?: string,
): string | null {
  if (!resolvedPerson) return null;

  if (resolvedPerson.ambiguous && resolvedPerson.candidates.length > 0) {
    const candidatesList = resolvedPerson.candidates.map((c) => `**${c}**`).join(" or ");
    return `I found multiple possible matches for that person. Did you mean ${candidatesList}?`;
  }

  if (resolvedPerson.confidence < 0.7 && resolvedPerson.value) {
    const name = rawNameOrMessage?.trim() || "that person";
    return `I found a partial match for "${name}". Did you mean **${resolvedPerson.value}**?`;
  }

  // FIX (Accuracy): a genuine total-miss (not ambiguous, no value, no
  // candidates — see the entity-resolver.ts else-branch fix) previously
  // fell through this function silently, since none of the branches
  // above matched a null value with zero candidates. That let the pipeline
  // continue to SQL with an empty personName and dead-end in a generic
  // "no data" answer. rawInput carries the name we actually tried and
  // failed to resolve, so we can tell the user what happened.
  if (!resolvedPerson.value && !resolvedPerson.ambiguous && resolvedPerson.candidates.length === 0) {
    const name = resolvedPerson.rawInput?.trim() || rawNameOrMessage?.trim();
    if (name) {
      return `I couldn't find anyone named "${name}" in the team. Could you check the spelling or try their full name?`;
    }
  }

  return null;
}