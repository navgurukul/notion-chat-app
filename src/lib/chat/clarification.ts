export type ResolvedPersonEntity = {
  value?: string;
  confidence: number;
  ambiguous?: boolean;
  candidates: string[];
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

  return null;
}
