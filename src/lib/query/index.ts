/**
 * Query router — decide SQL vs RAG from the user's question text.
 *
 * Entry: `resolveQuery(question)` in resolve-query.ts
 */
export { resolveQuery, resolveQueryRulesOnly } from "@/lib/query/resolve-query";
export { classifyQueryIntent } from "@/lib/query/intent-classifier";
export {
  parseQueryByRules,
  parseQueryByRules as parseQuery,
  extractCompareTitles,
  extractProjectSummaryTopic,
  isNoiseTopic,
} from "@/lib/query/rules";
export type { ParsedQuery, QueryKind, QuerySource, ClassifiedIntent } from "@/lib/query/types";
