/**
 * Ingestion layer — sync Notion → Postgres and build search index.
 *
 * Run via: Sync changes in UI, or `npx tsx scripts/sync-notion.ts`
 */
export { syncNotionToPostgres } from "@/lib/ingestion/sync";
export { chunkPageContent } from "@/lib/ingestion/chunk";
export type { PageChunk, PageChunkInput } from "@/lib/ingestion/chunk";
