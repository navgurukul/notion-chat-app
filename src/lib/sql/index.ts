/**
 * SQL layer — direct answers from synced Notion rows (no LLM).
 *
 * Used when the router detects owner, status, assigned list, page_about, etc.
 */
export { handleMetadataQuery, lookupPageLinkByTitle } from "@/lib/sql/answers";
