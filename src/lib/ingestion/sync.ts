/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PERFORMANCE IMPROVEMENTS over original:
 *
 * 1. PARALLEL PAGE PROCESSING — pages are processed in a concurrency-limited
 *    pool (default 8) instead of one-at-a-time. ~8× speedup on I/O-bound work.
 *    Set SYNC_CONCURRENCY=N in .env (recommended: 5–10).
 *
 * 2. BATCH DB INSERTS — replacePageChunks now uses a single UNNEST-based
 *    bulk INSERT instead of N individual INSERTs per chunk. Eliminates the
 *    per-chunk round-trip overhead.
 *
 * 3. RESUME SUPPORT — pass `resume: true` (or --resume flag) to skip pages
 *    already marked embedding_status='completed'. Crashed syncs restart from
 *    where they left off, not from page 1.
 *
 * 4. PROGRESS LOGGING — periodic progress reports every 50 pages so you know
 *    it's not hung.
 *
 * Schema migration required (if not already applied):
 *
 *   ALTER TABLE notion_chunks
 *     ADD COLUMN IF NOT EXISTS heading_path  text,
 *     ADD COLUMN IF NOT EXISTS char_count    integer NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS token_count   integer NOT NULL DEFAULT 0;
 */

import { Client } from "@notionhq/client";

import { ensureSchema, query, pool, setNotionLastSyncRun } from "@/lib/db";
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

// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------

/**
 * Returns a function that limits how many async tasks run at once.
 * Uses a simple semaphore — no external dependency needed.
 */
function createConcurrencyLimit(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length === 0 || active >= limit) return;
    active++;
    const resolve = queue.shift()!;
    resolve();
  }

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });

    try {
      return await task();
    } finally {
      active--;
      next();
    }
  };
}

function getSyncConcurrency(): number {
  const parsed = Number(process.env.SYNC_CONCURRENCY);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 8; // safe default: 8 parallel pages
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
      if (!isRetryableNotionError(error) || attempt === NOTION_RETRY_ATTEMPTS) break;
      const delayMs = 750 * 2 ** (attempt - 1);
      console.warn(`[sync] ${label} failed. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toVectorLiteral(values: number[] | null) {
  if (!values) return null;
  return `[${values.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /** Skip pages already marked completed — allows resuming a crashed sync. */
  resume?: boolean;
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

// ---------------------------------------------------------------------------
// Notion client helpers
// ---------------------------------------------------------------------------

function getNotionClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  return new Client({ auth: token });
}

function getTextFromRichText(richText?: Array<{ plain_text?: string }>) {
  if (!Array.isArray(richText)) return "";
  return richText.map((item) => item?.plain_text ?? "").join("");
}

function getPageTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title") {
      const title = getTextFromRichText(prop.title);
      if (title.trim()) return title.trim();
    }
  }
  return "Untitled";
}

function extractPropertyValue(prop: any): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case "title":     return getTextFromRichText(prop.title) || null;
    case "rich_text": return getTextFromRichText(prop.rich_text) || null;
    case "select":    return prop.select?.name ?? null;
    case "status":    return prop.status?.name ?? null;
    case "people":
      return prop.people?.map((item: any) => item?.name || item?.id).filter(Boolean).join(", ") || null;
    case "date":      return prop.date?.start ?? null;
    default:          return null;
  }
}

function findPropertyValueByName(properties: Record<string, any>, names: string[]) {
  const lowered = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(properties)) {
    if (lowered.has(key.toLowerCase())) {
      const parsed = extractPropertyValue(value);
      if (parsed?.trim()) return parsed.trim();
    }
  }
  return null;
}

function formatNotionBlockLine(block: any, depth = 0): string | null {
  const type = block?.type;
  if (!type) return null;
  const payload = block[type];

  if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
    const text = getTextFromRichText(payload?.rich_text).trim();
    if (!text) return null;
    const hashes = "#".repeat(type === "heading_1" ? 1 : type === "heading_2" ? 2 : 3);
    return `${hashes} ${text}`;
  }

  const indent = "  ".repeat(depth);

  if (type === "table_row") {
    const cells: string[] = (payload?.cells ?? []).map(
      (cell: Array<{ plain_text?: string }>) =>
        cell.map((rt) => rt?.plain_text ?? "").join(""),
    );
    return `${indent}| ${cells.join(" | ")} |`;
  }

  const text = getTextFromRichText(payload?.rich_text ?? payload?.title).trim();
  if (!text) return null;

  switch (type) {
    case "bulleted_list_item": return `${indent}- ${text}`;
    case "numbered_list_item": return `${indent}1. ${text}`;
    case "to_do": {
      const mark = payload?.checked ? "[x]" : "[ ]";
      return `${indent}[TO_DO] ${mark} ${text}`;
    }
    case "quote":   return `${indent}> ${text}`;
    case "callout": return `${indent}[CALLOUT] ${text}`;
    case "code": {
      const lang = payload?.language ?? "";
      return `${indent}\`\`\`${lang}\n${indent}${text}\n${indent}\`\`\``;
    }
    case "divider": return `${indent}---`;
    default:        return `${indent}${text}`;
  }
}

async function fetchBlocksRecursively(
  notion: Client,
  blockId: string,
  depth = 0,
): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await withNotionRetry(`blocks.list(${blockId})`, () =>
      notion.blocks.children.list({ block_id: blockId, page_size: PAGE_SIZE, start_cursor: cursor }),
    );

    for (const block of response.results as any[]) {
      const formatted = formatNotionBlockLine(block, depth);
      if (formatted) lines.push(formatted);
      if (block.has_children) {
        try {
          const children = await fetchBlocksRecursively(notion, block.id, depth + 1);
          lines.push(...children);
        } catch { /* skip failed child blocks */ }
      }
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return lines;
}

async function fetchAllPages(notion: Client) {
  const pages: any[] = [];
  const seenPageIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await withNotionRetry("notion.search", () =>
      notion.search({ page_size: PAGE_SIZE, start_cursor: cursor, filter: { property: "object", value: "page" } }),
    );

    for (const item of response.results) {
      if (item.object === "page" && !seenPageIds.has(item.id)) {
        seenPageIds.add(item.id);
        pages.push(item);
      }
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

type StoredPageState = {
  notion_edited_at: string | null;
  embedding_status: string | null;
};

async function loadStoredPageSyncState() {
  const rows = await query<{
    id: string;
    notion_edited_at: string | null;
    embedding_status: string | null;
  }>(`SELECT id, notion_edited_at::text, embedding_status FROM notion_pages`);
  return new Map(rows.map((row) => [row.id, { notion_edited_at: row.notion_edited_at, embedding_status: row.embedding_status }]));
}

function shouldSkipPage(
  pageId: string,
  notionEditedAt: string | null | undefined,
  stored: Map<string, StoredPageState>,
  options: SyncNotionOptions,
  embed: boolean,
): boolean {
  // Resume mode: skip pages already successfully embedded
  if (options.resume) {
    const row = stored.get(pageId);
    if (row?.embedding_status === EMBEDDING_STATUS.completed) return true;
  }

  if (options.force || options.refreshContent) return false;

  const row = stored.get(pageId);
  if (!row || !notionEditedAt) return false;
  if (row.notion_edited_at !== notionEditedAt) return false;
  if (embed && needsEmbeddingRetry(row.embedding_status)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function upsertPageRecord(params: {
  record: PageRecord;
  synced_at: string;
  pageEmbedding: number[] | null;
  embeddingStatus: EmbeddingStatus;
  lastError: string | null;
}) {
  const { record, synced_at, pageEmbedding, embeddingStatus, lastError } = params;
  await query(
    `INSERT INTO notion_pages (
      id, title, url, owner, created_by, last_edited_by, doc_type, status, due_date,
      content, embedding, synced_at, notion_edited_at, embedding_status, last_error
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector,$12,$13,$14,$15)
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title, url=EXCLUDED.url, owner=EXCLUDED.owner,
      created_by=EXCLUDED.created_by, last_edited_by=EXCLUDED.last_edited_by,
      doc_type=EXCLUDED.doc_type, status=EXCLUDED.status, due_date=EXCLUDED.due_date,
      content=EXCLUDED.content, embedding=EXCLUDED.embedding, synced_at=EXCLUDED.synced_at,
      notion_edited_at=EXCLUDED.notion_edited_at, embedding_status=EXCLUDED.embedding_status,
      last_error=EXCLUDED.last_error`,
    [
      record.id, record.title, record.url, record.owner, record.created_by,
      record.last_edited_by, record.doc_type, record.status, record.due_date,
      record.content, toVectorLiteral(pageEmbedding), synced_at,
      record.notion_edited_at, embeddingStatus, lastError,
    ],
  );
}

/**
 * FIX 2: Batch insert all chunks in a single UNNEST query instead of
 * looping N individual INSERTs. Eliminates N round-trips to Postgres per page.
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

  if (chunks.length === 0) {
    await query(`DELETE FROM notion_chunks WHERE page_id = $1`, [record.id]);
    return { chunkEmbedFailures: 0 };
  }

  const embeddings = embed
    ? await embedBatch(chunks.map((c) => c.content))
    : chunks.map(() => null);

  const chunkEmbedFailures = embed ? embeddings.filter((e) => !e).length : 0;

  // FIX: Use a dedicated pool client so BEGIN/DELETE/INSERT/COMMIT
  // all execute on the same Postgres connection. pool.query() can
  // route each call to a different connection, silently breaking transactions.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM notion_chunks WHERE page_id = $1`, [record.id]);

    // Build arrays for UNNEST bulk insert — one DB call instead of N individual INSERTs
    const pageIds           = chunks.map((c) => c.page_id);
    const chunkIndexes      = chunks.map((c) => c.chunk_index);
    const sectionHeadings   = chunks.map((c) => c.section_heading);
    const headingPaths      = chunks.map((c) => c.heading_path);
    const contents          = chunks.map((c) => c.content);
    const charCounts        = chunks.map((c) => c.char_count);
    const tokenCounts       = chunks.map((c) => c.token_count);
    const embeddingLiterals = embeddings.map((e) => toVectorLiteral(e));

    // pgvector requires ::vector cast — UNNEST with explicit cast per column
    await client.query(
      `INSERT INTO notion_chunks
        (page_id, chunk_index, section_heading, heading_path, content, char_count, token_count, embedding)
       SELECT
         unnest($1::text[])         AS page_id,
         unnest($2::int[])          AS chunk_index,
         unnest($3::text[])         AS section_heading,
         unnest($4::text[])         AS heading_path,
         unnest($5::text[])         AS content,
         unnest($6::int[])          AS char_count,
         unnest($7::int[])          AS token_count,
         unnest($8::text[])::vector AS embedding`,
      [pageIds, chunkIndexes, sectionHeadings, headingPaths, contents, charCounts, tokenCounts, embeddingLiterals],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return { chunkEmbedFailures };
}

async function buildPageRecord(notion: Client, page: any): Promise<PageRecord> {
  const properties = page?.properties ?? {};
  const title = getPageTitle(page);
  const blockLines = await fetchBlocksRecursively(notion, page.id, 0);
  const content = blockLines.join("\n\n");

  return {
    id: page.id,
    title,
    url: page.url ?? "",
    owner:          findPropertyValueByName(properties, ["owner", "assignee"]),
    created_by:     page?.created_by?.name ?? null,
    last_edited_by: page?.last_edited_by?.name ?? null,
    doc_type:       findPropertyValueByName(properties, ["type", "doc type"]),
    status:         findPropertyValueByName(properties, ["status"]),
    due_date:       findPropertyValueByName(properties, ["due date", "date"]),
    content,
    notion_edited_at: page?.last_edited_time ?? null,
  };
}

// ---------------------------------------------------------------------------
// Per-page processor (runs in parallel)
// ---------------------------------------------------------------------------

type PageSyncStats = {
  upserted: number;
  skipped: number;
  retried: number;
  embeddingsFailed: number;
};

async function processOnePage(
  page: any,
  notion: Client,
  embed: boolean,
  runStartedAt: string,
  storedSyncState: Map<string, StoredPageState>,
  options: SyncNotionOptions,
): Promise<PageSyncStats> {
  const stats: PageSyncStats = { upserted: 0, skipped: 0, retried: 0, embeddingsFailed: 0 };

  try {
    const notionEditedAt = page?.last_edited_time ?? null;
    const stored = storedSyncState.get(page.id);

    if (shouldSkipPage(page.id, notionEditedAt, storedSyncState, options, embed)) {
      stats.skipped = 1;
      return stats;
    }

    if (stored && needsEmbeddingRetry(stored.embedding_status)) {
      stats.retried = 1;
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
      stats.embeddingsFailed += 1;
      lastError = "Page embedding failed (quota or API error)";
    }

    let chunkEmbedFailures = 0;
    try {
      const chunkResult = await replacePageChunks(record, embed);
      chunkEmbedFailures = chunkResult.chunkEmbedFailures;
      if (chunkEmbedFailures > 0) {
        pageEmbedFailed = true;
        stats.embeddingsFailed += chunkEmbedFailures;
        lastError = `${chunkEmbedFailures} chunk embedding(s) failed`;
      }
    } catch (chunkError) {
      pageEmbedFailed = true;
      lastError = errorMessage(chunkError);
      console.error(`[sync] Chunk sync failed for ${record.title}:`, chunkError);
    }

    const embeddingStatus = resolveEmbeddingStatus(embed, pageEmbedFailed);

    await upsertPageRecord({
      record,
      synced_at: runStartedAt,
      pageEmbedding: embedding[0],
      embeddingStatus,
      lastError: pageEmbedFailed ? lastError : null,
    });

    stats.upserted = 1;

    const statusLabel =
      embeddingStatus === EMBEDDING_STATUS.failed    ? "Synced (embeddings failed)" :
      embeddingStatus === EMBEDDING_STATUS.pending   ? "Synced (embeddings pending)" :
                                                       "Synced";
    console.log(`${statusLabel}: ${record.title}`);
  } catch (error) {
    const pageId = page?.id;
    const message = errorMessage(error);
    console.error(`[sync] Sync failed for page ${page?.id}:`, error);

    if (pageId) {
      await query(
        `UPDATE notion_pages SET embedding_status=$2, last_error=$3 WHERE id=$1`,
        [pageId, EMBEDDING_STATUS.failed, message],
      ).catch(() => undefined);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncNotionToPostgres(
  options: SyncNotionOptions = {},
): Promise<SyncResult> {
  await ensureSchema();

  // Reset stuck "processing" pages from a previous crashed run
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
  const concurrency = getSyncConcurrency();
  const runStartedAt = new Date().toISOString();

  if (options.resume) {
    console.log("[sync] Resume mode — skipping pages already marked completed.");
  }

  console.log("[sync] Fetching page list from Notion...");
  const pages = await fetchAllPages(notion);
  const pageList =
    typeof options.limit === "number" && options.limit > 0
      ? pages.slice(0, options.limit)
      : pages;

  console.log(
    `[sync] Found ${pageList.length} page(s). embed=${embed} concurrency=${concurrency} — processing...`,
  );

  if (!embed) {
    console.warn("[sync] Embeddings disabled — FTS only.");
  }

  const storedSyncState = await loadStoredPageSyncState();
  const run = createConcurrencyLimit(concurrency);

  let upserted = 0;
  let skipped = 0;
  let retried = 0;
  let embeddingsFailed = 0;
  let processed = 0;

  // FIX 1: Process pages in parallel, concurrency-limited
  const tasks = pageList.map((page) =>
    run(() => processOnePage(page, notion, embed, runStartedAt, storedSyncState, options)),
  );

  for (const resultPromise of tasks) {
    const stats = await resultPromise;
    upserted          += stats.upserted;
    skipped           += stats.skipped;
    retried           += stats.retried;
    embeddingsFailed  += stats.embeddingsFailed;
    processed++;

    // Progress report every 50 pages
    if (processed % 50 === 0) {
      const pct = Math.round((processed / pageList.length) * 100);
      console.log(`[sync] Progress: ${processed}/${pageList.length} (${pct}%) — upserted=${upserted} skipped=${skipped} failed=${embeddingsFailed}`);
    }
  }

  if (skipped > 0) {
    console.log(`[sync] Skipped ${skipped} unchanged/completed page(s).`);
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