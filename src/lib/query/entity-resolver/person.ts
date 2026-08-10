import { resolvePersonName as dbResolvePersonName, getPeopleDirectory } from "@/lib/db";
import { getJsonCompletion } from "@/lib/ai/openai";
import { query } from "@/lib/db";

export enum ResolutionQuality {
  EXACT = "EXACT",
  FIRST_NAME = "FIRST_NAME",
  PARTIAL = "PARTIAL",
  NONE = "NONE"
}

export type ResolvedPerson = {
  value: string | null;
  quality: ResolutionQuality;
  confidence: number;
  ambiguous: boolean;
  candidates: string[];
};

export async function resolvePerson(input: string): Promise<ResolvedPerson> {
  const name = input.trim();
  if (!name || name.length < 2) {
    return { value: null, quality: ResolutionQuality.NONE, confidence: 0.0, ambiguous: false, candidates: [] };
  }

  // Force get directory to populate whitelist/cache
  await getPeopleDirectory();

  const res = await dbResolvePersonName(name);

  if (res.exact) {
    // Determine if exact or first_name or partial
    const dir = await getPeopleDirectory();
    let normalizedInput = name.toLowerCase();
    if (normalizedInput === "sanjana") {
      normalizedInput = "sanjna";
    }
    
    // Check if exact normalized match
    const exactMatch = dir.find((p) => p.normalized === normalizedInput);
    if (exactMatch) {
      return {
        value: res.exact,
        quality: ResolutionQuality.EXACT,
        confidence: 1.0,
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
        confidence: 0.9,
        ambiguous: false,
        candidates: []
      };
    }

    // Else it is a single partial match
    return {
      value: res.exact,
      quality: ResolutionQuality.PARTIAL,
      confidence: 0.5,
      ambiguous: false,
      candidates: []
    };
  }

  if (res.candidates.length > 0) {
    return {
      value: null,
      quality: ResolutionQuality.PARTIAL,
      confidence: 0.5,
      ambiguous: true,
      candidates: res.candidates
    };
  }

  return {
    value: null,
    quality: ResolutionQuality.NONE,
    confidence: 0.0,
    ambiguous: false,
    candidates: []
  };
}

const inMemoryGenderCache = new Map<string, "male" | "female">();

export async function getGenderOfPerson(name: string): Promise<"male" | "female"> {
  const firstName = name.trim().toLowerCase().split(/\s+/)[0];
  if (!firstName) return "male";

  // 1. In-memory Cache
  if (inMemoryGenderCache.has(firstName)) {
    return inMemoryGenderCache.get(firstName)!;
  }

  // 2. Static Fast Path for known names
  const FEMALE_NAMES = new Set([
    "alima", "amruta", "apeksha", "archana", "ashwini", "chhaya", "dhanshri", "goldy",
    "gunavathi", "ira", "komal", "neelam", "neha", "nikita", "pooja", "poonam", "prachi",
    "pranjal", "pranjali", "priya", "priyanka", "saloni", "sanjna", "sanjana", "sapna", "sheetal",
    "sugatha", "sukanya", "tamanna", "ujala", "urmila", "vishakha", "also "
  ]);
  const MALE_NAMES = new Set([
    "aadarsh", "abhishek", "aniket", "anirudh", "arunesh", "gaurav", "mahendra", "mayur",
    "nasir", "mukul", "narendra", "nilesh", "numan", "parichay", "piyush", "prabhat", "priyomjeet",
    "puran", "rohit", "saksham", "santosh", "saquib", "shailesh", "souvik", "suraj", "vinit"
  ]);

  if (FEMALE_NAMES.has(firstName)) {
    inMemoryGenderCache.set(firstName, "female");
    return "female";
  }
  if (MALE_NAMES.has(firstName)) {
    inMemoryGenderCache.set(firstName, "male");
    return "male";
  }

  // 3. Database lookup
  try {
    const dbResult = await query<{ gender: string }>(
      "SELECT gender FROM name_genders WHERE name = $1 LIMIT 1",
      [firstName]
    );
    if (dbResult.length > 0) {
      const g = dbResult[0].gender === "female" ? "female" : "male";
      inMemoryGenderCache.set(firstName, g);
      return g;
    }
  } catch (error) {
    console.error("[postgres] failed to lookup name_genders:", error);
  }

  // 4. LLM Lookup
  try {
    const systemPrompt = `Identify the typical gender of the given first name (often Indian or International). Return JSON: { "gender": "male" | "female" }`;
    const userPrompt = `Name: ${firstName}`;
    const raw = await getJsonCompletion(systemPrompt, userPrompt);
    const jsonText = raw.trim().match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonText) as { gender?: string };
    const detected: "male" | "female" = parsed.gender?.toLowerCase() === "female" ? "female" : "male";

    // Cache to DB
    await query(
      `INSERT INTO name_genders (name, gender) 
       VALUES ($1, $2) 
       ON CONFLICT (name) DO UPDATE SET gender = EXCLUDED.gender`,
      [firstName, detected]
    ).catch(err => console.error("[postgres] failed to save to name_genders:", err));

    inMemoryGenderCache.set(firstName, detected);
    return detected;
  } catch (error) {
    console.error("[LLM] gender lookup failed for name:", firstName, error);
    return "male"; // fallback
  }
}
