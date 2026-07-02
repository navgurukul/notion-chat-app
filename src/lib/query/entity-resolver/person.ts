import { resolvePersonName as dbResolvePersonName, getPeopleDirectory } from "@/lib/db/team-members";

export enum ResolutionQuality {
  EXACT = "EXACT",
  FIRST_NAME = "FIRST_NAME",
  PARTIAL = "PARTIAL",
  NONE = "NONE"
}

export type ResolvedPerson = {
  value: string | null;
  quality: ResolutionQuality;
  ambiguous: boolean;
  candidates: string[];
};

export async function resolvePerson(input: string): Promise<ResolvedPerson> {
  const name = input.trim();
  if (!name || name.length < 2) {
    return { value: null, quality: ResolutionQuality.NONE, ambiguous: false, candidates: [] };
  }

  // Force get directory to populate whitelist/cache
  await getPeopleDirectory();

  const res = await dbResolvePersonName(name);

  if (res.exact) {
    // Determine if exact or first_name or partial
    const dir = await getPeopleDirectory();
    const normalizedInput = name.toLowerCase();
    
    // Check if exact normalized match
    const exactMatch = dir.find((p) => p.normalized === normalizedInput);
    if (exactMatch) {
      return {
        value: res.exact,
        quality: ResolutionQuality.EXACT,
        ambiguous: false,
        candidates: []
      };
    }

    // Check if first-name match
    const firstNameMatches = dir.filter((p) => {
      const firstName = p.normalized.split(/\s+/)[0];
      return firstName === normalizedInput;
    });
    if (firstNameMatches.length === 1 && firstNameMatches[0].name === res.exact) {
      return {
        value: res.exact,
        quality: ResolutionQuality.FIRST_NAME,
        ambiguous: false,
        candidates: []
      };
    }

    // Else it is a single partial match
    return {
      value: res.exact,
      quality: ResolutionQuality.PARTIAL,
      ambiguous: false,
      candidates: []
    };
  }

  if (res.candidates.length > 0) {
    return {
      value: null,
      quality: ResolutionQuality.PARTIAL,
      ambiguous: true,
      candidates: res.candidates
    };
  }

  return {
    value: null,
    quality: ResolutionQuality.NONE,
    ambiguous: false,
    candidates: []
  };
}
