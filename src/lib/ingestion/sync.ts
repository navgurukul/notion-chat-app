/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Schema migration required before deploying this version:
 *
 *   ALTER TABLE notion_chunks
 *     ADD COLUMN IF NOT EXISTS heading_path  text,
 *     ADD COLUMN IF NOT EXISTS char_count    integer NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS token_count   integer NOT NULL DEFAULT 0;
 *
 * After migrating, run a full rebuild to populate the new columns:
 *   syncNotionToPostgres({ force: true, embed: true })
 */

import { Client } from "@notionhq/client";

import { ensureSchema, query, setNotionLastSyncRun } from "@/lib/db";
import { chunkPageContent } from "@/lib/ingestion/chunk";

import {
  embedBatch,
  buildEmbeddingText,
  isEmbeddingsEnabled,
} from "@/lib/ai/embeddings";
import {
  EMBEDDING_STATUS,
  needsEmbeddingRetry,
  resolveEmbeddingStatus,
  type EmbeddingStatus,
} from "@/lib/ingestion/sync-status";

const PAGE_SIZE = 100;
const NOTION_RETRY_ATTEMPTS = 4;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(error: unknown) {
  const status =
    (error as { status?: number })?.status ??
    Number((error as { code?: string })?.code);

  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function withNotionRetry<T>(label: string, operation: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= NOTION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableNotionError(error) || attempt === NOTION_RETRY_ATTEMPTS) {
        break;
      }

      const delayMs = 750 * 2 ** (attempt - 1);
      console.warn(`[sync] ${label} failed. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export type SyncResult = {
  totalPages: number;
  upserted: number;
  skipped: number;
  retried: number;
  embeddingsFailed: number;
  embeddingsSkipped: boolean;
  synced_at: string;
};

export type SyncNotionOptions = {
  force?: boolean;
  embed?: boolean;
  refreshContent?: boolean;
  limit?: number;
};

type PageRecord = {
  id: string;
  title: string;
  url: string;

  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;

  doc_type: string | null;
  status: string | null;

  due_date: string | null;

  content: string;

  notion_edited_at: string | null;
};

function getNotionClient() {
  const token = process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error("NOTION_TOKEN is not set");
  }

  return new Client({
    auth: token,
  });
}

function getTextFromRichText(richText?: Array<{ plain_text?: string }>) {
  if (!Array.isArray(richText)) return "";

  return richText
    .map((item) => item?.plain_text ?? "")
    .join("");
}

function getPageTitle(page: any): string {
  const props = page?.properties ?? {};

  for (const key of Object.keys(props)) {
    const prop = props[key];

    if (prop?.type === "title") {
      const title = getTextFromRichText(prop.title);

      if (title.trim()) {
        return title.trim();
      }
    }
  }

  return "Untitled";
}

function extractPropertyValue(prop: any): string | null {
  if (!prop) return null;

  switch (prop.type) {
    case "title":
      return getTextFromRichText(prop.title) || null;

    case "rich_text":
      return getTextFromRichText(prop.rich_text) || null;

    case "select":
      return prop.select?.name ?? null;

    case "status":
      return prop.status?.name ?? null;

    case "people":
      return (
        prop.people
          ?.map((item: any) => item?.name || item?.id)
          .filter(Boolean)
          .join(", ") || null
      );

    case "date":
      return prop.date?.start ?? null;

    default:
      return null;
  }
}

function findPropertyValueByName(
  properties: Record<string, any>,
  names: string[],
) {
  const lowered = new Set(names.map((n) => n.toLowerCase()));

  for (const [key, value] of Object.entries(properties)) {
    if (lowered.has(key.toLowerCase())) {
      const parsed = extractPropertyValue(value);

      if (parsed?.trim()) {
        return parsed.trim();
      }
    }
  }

  return null;
}

/**
 * Convert a Notion block to a text line.
 *
 * Depth is passed from the recursive fetcher so nested bullets are indented.
 * Headings are never indented — they anchor section boundaries.
 *
 * Priority 3: callouts, to-dos, and tables carry semantic markers so the
 * chunker (and the embedding) know these are not plain prose.
 */
function formatNotionBlockLine(block: any, depth = 0): string | null {
  const type = block?.type;
  if (!type) return null;

  const payload = block[type];

  // --- Headings (no indent — they drive section splitting in chunk.ts) ---
  if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
    const text = getTextFromRichText(payload?.rich_text).trim();
    if (!text) return null;
    const hashes = "#".repeat(type === "heading_1" ? 1 : type === "heading_2" ? 2 : 3);
    return `${hashes} ${text}`;
  }

  const indent = "  ".repeat(depth);

  // --- Table row: join cells with pipe separators ---
  if (type === "table_row") {
    const cells: string[] = (payload?.cells ?? []).map(
      (cell: Array<{ plain_text?: string }>) =>
        cell.map((rt) => rt?.plain_text ?? "").join(""),
    );
    return `${indent}| ${cells.join(" | ")} |`;
  }

  // For all remaining types we need the rich-text content
  const text = getTextFromRichText(payload?.rich_text ?? payload?.title).trim();
  if (!text) return null;

  switch (type) {
    case "bulleted_list_item":
      return `${indent}- ${text}`;

    case "numbered_list_item":
      return `${indent}1. ${text}`;

    case "to_do": {
      // Priority 3: preserve checked state as a semantic marker
      const mark = payload?.checked ? "[x]" : "[ ]";
      return `${indent}[TO_DO] ${mark} ${text}`;
    }

    case "quote":
      return `${indent}> ${text}`;

    case "callout":
      // Priority 3: callout marker so the embedding captures advisory tone
      return `${indent}[CALLOUT] ${text}`;

    case "code": {
      const lang = payload?.language ?? "";
      return `${indent}\`\`\`${lang}\n${indent}${text}\n${indent}\`\`\``;
    }

    case "divider":
      return `${indent}---`;

    default:
      return `${indent}${text}`;
  }
}

/**
 * Fetch all blocks for a page/block, recursively following has_children.
 * Depth is incremented on each recursive call so child blocks are indented.
 */
async function fetchBlocksRecursively(
  notion: Client,
  blockId: string,
  depth = 0,
): Promise<string[]> {
  const lines: string[] = [];

  let cursor: string | undefined;

  do {
    const response = await withNotionRetry(`blocks.list(${blockId})`, () =>
      notion.blocks.children.list({
        block_id: blockId,
        page_size: PAGE_SIZE,
        start_cursor: cursor,
      }),
    );

    for (const block of response.results as any[]) {
      const formatted = formatNotionBlockLine(block, depth);
      if (formatted) {
        lines.push(formatted);
      }

      if (block.has_children) {
        try {
          const children = await fetchBlocksRecursively(
            notion,
            block.id,
            depth + 1,  // FIX 3: increment depth for children
          );

          lines.push(...children);
        } catch {
          //
        }
      }
    }

    cursor = response.has_more
      ? response.next_cursor ?? undefined
      : undefined;
  } while (cursor);

  return lines;
}

async function fetchAllPages(notion: Client) {
  const pages: any[] = [];
  const seenPageIds = new Set<string>();

  let cursor: string | undefined;

  do {
    const response = await withNotionRetry("notion.search", () =>
      notion.search({
        page_size: PAGE_SIZE,
        start_cursor: cursor,
        filter: {
          property: "object",
          value: "page",
        },
      }),
    );

    for (const item of response.results) {
      if (item.object === "page" && !seenPageIds.has(item.id)) {
        seenPageIds.add(item.id);
        pages.push(item);
      }
    }

    cursor = response.has_more
      ? response.next_cursor ?? undefined
      : undefined;
  } while (cursor);

  return pages;
}

type StoredPageState = {
  notion_edited_at: string | null;
  embedding_status: string | null;
};

async function loadStoredPageSyncState() {
  const rows = await query<{
    id: string;
    notion_edited_at: string | null;
    embedding_status: string | null;
  }>(
    `SELECT id, notion_edited_at::text, embedding_status FROM notion_pages`,
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        notion_edited_at: row.notion_edited_at,
        embedding_status: row.embedding_status,
      },
    ]),
  );
}

function shouldSkipUnchangedPage(
  pageId: string,
  notionEditedAt: string | null | undefined,
  stored: Map<string, StoredPageState>,
  options: SyncNotionOptions,
  embed: boolean,
) {
  if (options.force || options.refreshContent) return false;

  const row = stored.get(pageId);
  if (!row || !notionEditedAt) return false;
  if (row.notion_edited_at !== notionEditedAt) return false;

  if (embed && needsEmbeddingRetry(row.embedding_status)) {
    return false;
  }

  return true;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toVectorLiteral(values: number[] | null) {
  if (!values) return null;

  return `[${values.join(",")}]`;
}

/**
 * FIX 4: Wrap the DELETE + INSERT sequence in a transaction so a crash or
 * embedding failure mid-way never leaves a page with zero chunks in the DB.
 */
async function replacePageChunks(
  record: PageRecord,
  embed: boolean,
): Promise<{ chunkEmbedFailures: number }> {
  const chunks = chunkPageContent({
    id: record.id,
    title: record.title,
    content: record.content,

    owner: record.owner,
    status: record.status,
    doc_type: record.doc_type,

    created_by: record.created_by,
    last_edited_by: record.last_edited_by,
  });

  // FIX 2 side effect: chunkPageContent now returns [] for empty pages.
  // Nothing to insert — delete stale chunks and exit cleanly.
  if (chunks.length === 0) {
    await query(`DELETE FROM notion_chunks WHERE page_id = $1`, [record.id]);
    return { chunkEmbedFailures: 0 };
  }

  const embeddings = embed
    ? await embedBatch(chunks.map((chunk) => chunk.content))
    : chunks.map(() => null);

  let chunkEmbedFailures = 0;

  // FIX 4: BEGIN transaction — DELETE + all INSERTs are atomic.
  await query("BEGIN");

  try {
    await query(`DELETE FROM notion_chunks WHERE page_id = $1`, [record.id]);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      if (embed && !embedding) {
        chunkEmbedFailures += 1;
      }

      await query(
        `
        INSERT INTO notion_chunks (
          page_id,
          chunk_index,
          section_heading,
          heading_path,
          content,
          char_count,
          token_count,
          embedding
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::vector
        )
        `,
        [
          chunk.page_id,
          chunk.chunk_index,
          chunk.section_heading,
          chunk.heading_path,
          chunk.content,
          chunk.char_count,
          chunk.token_count,
          toVectorLiteral(embedding),
        ],
      );
    }

    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  return { chunkEmbedFailures };
}

async function upsertPageRecord(params: {
  record: PageRecord;
  synced_at: string;
  pageEmbedding: number[] | null;
  embeddingStatus: EmbeddingStatus;
  lastError: string | null;
}) {
  const { record, synced_at, pageEmbedding, embeddingStatus, lastError } = params;

  await query(
    `
    INSERT INTO notion_pages (
      id,
      title,
      url,
      owner,
      created_by,
      last_edited_by,
      doc_type,
      status,
      due_date,
      content,
      embedding,
      synced_at,
      notion_edited_at,
      embedding_status,
      last_error
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12, $13, $14, $15
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      owner = EXCLUDED.owner,
      created_by = EXCLUDED.created_by,
      last_edited_by = EXCLUDED.last_edited_by,
      doc_type = EXCLUDED.doc_type,
      status = EXCLUDED.status,
      due_date = EXCLUDED.due_date,
      content = EXCLUDED.content,
      embedding = EXCLUDED.embedding,
      synced_at = EXCLUDED.synced_at,
      notion_edited_at = EXCLUDED.notion_edited_at,
      embedding_status = EXCLUDED.embedding_status,
      last_error = EXCLUDED.last_error
    `,
    [
      record.id,
      record.title,
      record.url,
      record.owner,
      record.created_by,
      record.last_edited_by,
      record.doc_type,
      record.status,
      record.due_date,
      record.content,
      toVectorLiteral(pageEmbedding),
      synced_at,
      record.notion_edited_at,
      embeddingStatus,
      lastError,
    ],
  );
}

async function buildPageRecord(
  notion: Client,
  page: any,
): Promise<PageRecord> {
  const properties = page?.properties ?? {};

  const title = getPageTitle(page);

  // FIX 3: start at depth=0; recursive calls will increment for nested blocks
  const blockLines = await fetchBlocksRecursively(notion, page.id, 0);

  const content = blockLines.join("\n\n");

  return {
    id: page.id,

    title,

    url: page.url ?? "",

    owner: findPropertyValueByName(
      properties,
      ["owner", "assignee"],
    ),

    created_by:
      page?.created_by?.name ?? null,

    last_edited_by:
      page?.last_edited_by?.name ?? null,

    doc_type: findPropertyValueByName(
      properties,
      ["type", "doc type"],
    ),

    status: findPropertyValueByName(
      properties,
      ["status"],
    ),

    due_date: findPropertyValueByName(
      properties,
      ["due date", "date"],
    ),

    content,

    notion_edited_at:
      page?.last_edited_time ?? null,
  };
}

export async function syncNotionToPostgres(
  options: SyncNotionOptions = {},
): Promise<SyncResult> {
  await ensureSchema();

  await query(`
  UPDATE notion_pages
  SET embedding_status = 'failed',
      last_error = 'Interrupted — previous sync did not complete'
  WHERE embedding_status = 'processing'
    AND synced_at IS NOT NULL
    AND synced_at < NOW() - INTERVAL '2 hours'
`);
  

  const notion = getNotionClient();
  const embed = options.embed !== false && isEmbeddingsEnabled();
  const runStartedAt = new Date().toISOString();

  console.log("[sync] Fetching page list from Notion...");
  const pages = await fetchAllPages(notion);
  const pageList =
    typeof options.limit === "number" && options.limit > 0
      ? pages.slice(0, options.limit)
      : pages;

  console.log(
    `[sync] Found ${pageList.length} page(s). embed=${embed} — processing (this can take hours with embeddings)...`,
  );

  if (!embed) {
    console.warn(
      "[sync] Embeddings disabled — storing Notion text and FTS chunks only (set OPENAI_API_KEY + billing, or omit EMBEDDINGS_ENABLED=false).",
    );
  }

  const storedSyncState = await loadStoredPageSyncState();

  let upserted = 0;
  let skipped = 0;
  let retried = 0;
  let embeddingsFailed = 0;

  for (const page of pageList) {
    try {
      const notionEditedAt = page?.last_edited_time ?? null;
      const stored = storedSyncState.get(page.id);

      if (
        shouldSkipUnchangedPage(
          page.id,
          notionEditedAt,
          storedSyncState,
          options,
          embed,
        )
      ) {
        skipped += 1;
        continue;
      }

      if (stored && needsEmbeddingRetry(stored.embedding_status)) {
        retried += 1;
      }

      const record = await buildPageRecord(notion, page);

      await upsertPageRecord({
        record,
        synced_at: runStartedAt,
        pageEmbedding: null,
        embeddingStatus: EMBEDDING_STATUS.processing,
        lastError: null,
      });

      let pageEmbedFailed = false;
      let lastError: string | null = null;

      const embedding = embed
        ? await embedBatch([
            buildEmbeddingText({
              title: record.title,
              owner: record.owner,
              created_by: record.created_by,
              last_edited_by: record.last_edited_by,
              doc_type: record.doc_type,
              status: record.status,
              content: record.content,
            }),
          ])
        : [null];

      if (embed && !embedding[0]) {
        pageEmbedFailed = true;
        embeddingsFailed += 1;
        lastError = "Page embedding failed (quota or API error)";
      }

      let chunkEmbedFailures = 0;
      try {
        const chunkResult = await replacePageChunks(record, embed);
        chunkEmbedFailures = chunkResult.chunkEmbedFailures;
        if (chunkEmbedFailures > 0) {
          pageEmbedFailed = true;
          embeddingsFailed += chunkEmbedFailures;
          lastError = `${chunkEmbedFailures} chunk embedding(s) failed`;
        }
      } catch (chunkError) {
        pageEmbedFailed = true;
        lastError = errorMessage(chunkError);
        console.error(`Chunk sync failed for ${record.title}:`, chunkError);
      }

      const embeddingStatus = resolveEmbeddingStatus(embed, pageEmbedFailed);

      await upsertPageRecord({
        record,
        synced_at: runStartedAt,
        pageEmbedding: embedding[0],
        embeddingStatus,
        lastError: pageEmbedFailed ? lastError : null,
      });

      upserted += 1;

      const statusLabel =
        embeddingStatus === EMBEDDING_STATUS.failed
          ? "Synced (embeddings failed)"
          : embeddingStatus === EMBEDDING_STATUS.pending
            ? "Synced (embeddings pending)"
            : "Synced";
      console.log(`${statusLabel}: ${record.title}`);
    } catch (error) {
      const pageId = page?.id;
      const message = errorMessage(error);
      console.error(`Sync failed for page:`, error);

      if (pageId) {
        await query(
          `
          UPDATE notion_pages
          SET embedding_status = $2, last_error = $3
          WHERE id = $1
          `,
          [pageId, EMBEDDING_STATUS.failed, message],
        ).catch(() => undefined);
      }
    }
  }

  if (skipped > 0) {
    console.log(`[sync] Skipped ${skipped} unchanged page(s).`);
  }

  const synced_at = new Date().toISOString();
  await setNotionLastSyncRun(synced_at);

  return {
    totalPages: pageList.length,
    upserted,
    skipped,
    retried,
    embeddingsFailed,
    embeddingsSkipped: !embed,
    synced_at,
  };
}