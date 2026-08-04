export type QueryIntent =
  | "PERSON_ACTIVITY"
  | "PERSON_OWNERSHIP"
  | "PROJECT_TEAM"
  | "PROJECT_SUMMARY"
  | "PROJECT_STATUS"
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

  return "UNKNOWN";
}