/**
 * CLI: full Notion → Postgres sync (including `notion_chunks` when embed is on).
 *
 * Usage (from repo root, with .env loaded):
 *   npx tsx scripts/sync-notion.ts --force --refresh-content
 *
 * Env:
 *   EMBED=false          — skip embeddings (chunks still created, embedding NULL)
 *   FORCE_SYNC=true     — same as --force
 *   REFRESH_CONTENT=true — same as --refresh-content
 *   SYNC_PAGE_LIMIT=10    — max pages to sync (same as --limit 10)
 */
import "dotenv/config";
import { syncNotionToPostgres } from "../src/lib/ingestion";

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function readLimit(): number | undefined {
  const flagArg = process.argv.find((arg) => arg.startsWith("--limit="));
  if (flagArg) {
    const parsed = Number.parseInt(flagArg.split("=")[1] ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const limitIndex = process.argv.indexOf("--limit");
  if (limitIndex >= 0) {
    const parsed = Number.parseInt(process.argv[limitIndex + 1] ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const envParsed = Number.parseInt(process.env.SYNC_PAGE_LIMIT ?? "", 10);
  if (Number.isFinite(envParsed) && envParsed > 0) return envParsed;

  return undefined;
}

async function main() {
  const force = hasFlag("--force") || process.env.FORCE_SYNC === "true";
  const refreshContent = hasFlag("--refresh-content") || process.env.REFRESH_CONTENT === "true";
  const embed = process.env.EMBED !== "false" && !hasFlag("--no-embed");
  const limit = readLimit();

  console.log(
    `[sync-notion] force=${force} refreshContent=${refreshContent} embed=${embed} limit=${limit ?? "none"}`,
  );
  const result = await syncNotionToPostgres({ force, embed, refreshContent, limit });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
