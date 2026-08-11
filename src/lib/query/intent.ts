export type QueryIntent =
  | "PERSON_ACTIVITY"
  | "PERSON_OWNERSHIP"
  | "PROJECT_TEAM"
  | "PROJECT_SUMMARY"
  | "PROJECT_STATUS"
  | "ANALYTICS"
  | "COMPARISON"
  | "UNKNOWN";

export function detectIntent(query: string): QueryIntent {
  const q = query.toLowerCase();

  if (
    /what.*working on|what.*work on|tasks.*working|currently working/i.test(q)
  ) {
    return "PERSON_ACTIVITY";
  }

  if (/projects?.*own|owner of|which project.*owner/i.test(q)) {
    return "PERSON_OWNERSHIP";
  }

  if (
    /team members|who is working on|who all work on|members involved/i.test(q)
  ) {
    return "PROJECT_TEAM";
  }

  if (/tell me about|explain|overview|summary/i.test(q)) {
    return "PROJECT_SUMMARY";
  }

  if (/status of|progress of|current status/i.test(q)) {
    return "PROJECT_STATUS";
  }

  if (
    /compare|difference between|versus|\bvs\b|which\s+is\s+better|how\s+does\s+.*\s+compare/i.test(q)
  ) {
    return "COMPARISON";
  }

  if (
    /\b(most|least|top|highest|lowest|count|counts|number of|how many|breakdown|group by|rank|ranking|average|avg)\b/i.test(q)
  ) {
    return "ANALYTICS";
  }

  return "UNKNOWN";
}