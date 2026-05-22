/**
 * Backfill notion_pages.notion_edited_at from Notion search API last_edited_time.
 * Metadata only — no block fetch.
 *
 * Usage:
 *   npx tsx scripts/backfill-notion-edited-at.ts
 */
import "dotenv/config";
import { Client } from "@notionhq/client";
import { ensureSchema, query } from "../src/lib/db";

const PAGE_SIZE = 100;

function getNotionClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  return new Client({ auth: token });
}

async function fetchAllPagesFromSearch(notion: Client) {
  const pages: Array<{ id: string; last_edited_time: string | null }> = [];
  let cursor: string | undefined;

  do {
    const response = await notion.search({
      page_size: PAGE_SIZE,
      start_cursor: cursor,
      filter: { property: "object", value: "page" },
    });

    for (const item of response.results) {
      if (item.object !== "page" || !("last_edited_time" in item)) continue;
      pages.push({
        id: item.id,
        last_edited_time: item.last_edited_time ?? null,
      });
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

async function main() {
  await ensureSchema();
  const notion = getNotionClient();
  const pages = await fetchAllPagesFromSearch(notion);

  let updated = 0;
  let skippedNoTimestamp = 0;
  let notInDb = 0;

  for (const page of pages) {
    if (!page.last_edited_time) {
      skippedNoTimestamp += 1;
      continue;
    }

    const rows = await query<{ id: string }>(
      `
      UPDATE notion_pages
      SET notion_edited_at = $1::timestamptz
      WHERE id = $2
      RETURNING id
      `,
      [page.last_edited_time, page.id],
    );

    if (rows.length > 0) {
      updated += 1;
    } else {
      notInDb += 1;
    }
  }

  const [chunksWithEmbedding, pagesWithEditedAt] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notion_chunks WHERE embedding IS NOT NULL`,
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notion_pages WHERE notion_edited_at IS NOT NULL`,
    ),
  ]);

  const result = {
    notion_pages_found: pages.length,
    updated,
    skipped_no_timestamp: skippedNoTimestamp,
    not_in_db: notInDb,
    db_counts: {
      notion_chunks_with_embedding: Number(chunksWithEmbedding[0]?.count ?? 0),
      notion_pages_with_notion_edited_at: Number(pagesWithEditedAt[0]?.count ?? 0),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
