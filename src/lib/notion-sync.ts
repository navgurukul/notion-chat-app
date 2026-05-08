/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client } from "@notionhq/client";
import { buildEmbeddingText, embedBatch } from "@/lib/embeddings";
import { ensureSchema, query } from "@/lib/postgres";

const PAGE_SIZE = 100;
const SYNC_CHUNK_SIZE = 20;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

export type SyncResult = {
  totalPages: number;
  upserted: number;
  skippedUnchanged: number;
  embeddingsFailed: number;
  synced_at: string;
};

type SyncRow = {
  id: string;
  synced_at: string;
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
  lastEditedTime: string | null;
};

function getNotionClient() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  return new Client({ auth: token });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNotionError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number; statusCode?: number }).status ??
    (error as { status?: number; statusCode?: number }).statusCode;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) return true;

  const code = String((error as { code?: string }).code ?? "");
  return code === "rate_limited" || code === "service_unavailable" || code === "internal_server_error";
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
  timeoutMs = 25000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          const timeout = setTimeout(() => {
            clearTimeout(timeout);
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      lastError = error;
      const timedOut = error instanceof Error && /timed out/i.test(error.message);
      if ((!isRetryableNotionError(error) && !timedOut) || attempt === maxAttempts) break;
      const delayMs = 500 * 2 ** (attempt - 1);
      console.warn(`[sync] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError;
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
    case "title":
      return getTextFromRichText(prop.title) || null;
    case "rich_text":
      return getTextFromRichText(prop.rich_text) || null;
    case "number":
      return Number.isFinite(prop.number) ? String(prop.number) : null;
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return prop.multi_select?.map((item: any) => item?.name).filter(Boolean).join(", ") || null;
    case "status":
      return prop.status?.name ?? null;
    case "date":
      return prop.date?.start ?? null;
    case "people":
      return prop.people?.map((item: any) => item?.name || item?.id).filter(Boolean).join(", ") || null;
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    case "url":
      return prop.url ?? null;
    case "email":
      return prop.email ?? null;
    case "phone_number":
      return prop.phone_number ?? null;
    case "created_by":
      return prop.created_by?.name || prop.created_by?.id || null;
    case "last_edited_by":
      return prop.last_edited_by?.name || prop.last_edited_by?.id || null;
    default:
      return null;
  }
}

function findPropertyValueByName(properties: Record<string, any>, names: string[]) {
  const lowered = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(properties)) {
    if (lowered.has(key.toLowerCase())) {
      const parsed = extractPropertyValue(value);
      if (parsed?.trim()) return parsed.trim();
    }
  }
  return null;
}

function extractDueDate(properties: Record<string, any>): string | null {
  const candidate = findPropertyValueByName(properties, ["due date", "due", "date"]);
  if (!candidate) return null;
  const dateOnly = candidate.split("T")[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

function extractTextFromBlock(block: any): string {
  const type = block?.type;
  if (!type) return "";
  const rich = block?.[type]?.rich_text;
  const text = getTextFromRichText(rich).trim();
  if (!text) return "";

  if (type === "heading_1") return `# ${text}`;
  if (type === "heading_2") return `## ${text}`;
  if (type === "heading_3") return `### ${text}`;
  if (type === "bulleted_list_item") return `- ${text}`;
  if (type === "numbered_list_item") return `1. ${text}`;
  if (type === "to_do") return `${block?.to_do?.checked ? "[x]" : "[ ]"} ${text}`;
  if (type === "quote") return `> ${text}`;
  return text;
}

async function fetchBlocksRecursively(
  notion: Client,
  blockId: string,
  depth: number = 0,
): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await withRetry(
      () =>
        notion.blocks.children.list({
          block_id: blockId,
          page_size: PAGE_SIZE,
          start_cursor: cursor,
        }),
      `blocks.children.list(${blockId})`,
    );

    for (const block of response.results as any[]) {
      const text = extractTextFromBlock(block);
      if (text) lines.push(`${"  ".repeat(depth)}${text}`);

      if (block?.has_children) {
        try {
          const childLines = await fetchBlocksRecursively(notion, block.id, depth + 1);
          lines.push(...childLines);
        } catch {
          // Skip unsupported child block branches and continue sync.
        }
      }
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return lines;
}

async function fetchAllPages(notion: Client) {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await withRetry(
      () =>
        notion.search({
          page_size: PAGE_SIZE,
          start_cursor: cursor,
          filter: { property: "object", value: "page" },
        }),
      "notion.search",
    );
    for (const item of response.results) {
      if (item.object === "page") pages.push(item);
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

function toVectorLiteral(values: number[] | null) {
  if (!values) return null;
  return `[${values.join(",")}]`;
}

function shouldSkipPage(page: any, existingSyncMap: Map<string, string>) {
  const existingSyncedAt = existingSyncMap.get(page.id);
  if (!existingSyncedAt) return false;

  const lastEdited = page?.last_edited_time;
  if (!lastEdited) return false;

  const editedAtMs = new Date(lastEdited).getTime();
  const syncedAtMs = new Date(existingSyncedAt).getTime();

  if (!Number.isFinite(editedAtMs) || !Number.isFinite(syncedAtMs)) return false;
  return editedAtMs <= syncedAtMs;
}

async function buildPageRecord(notion: Client, page: any): Promise<PageRecord> {
  const properties = (page?.properties ?? {}) as Record<string, any>;
  const title = getPageTitle(page);
  const contentLines = await fetchBlocksRecursively(notion, page.id);
  const content = contentLines.length
    ? contentLines.join("\n")
    : `This is a Notion page titled "${title}".`;

  return {
    id: page.id,
    title,
    url: page.url ?? "",
    owner: findPropertyValueByName(properties, ["owner", "assignee", "assignees"]),
    created_by:
      page?.created_by?.name ||
      findPropertyValueByName(properties, ["created by", "creator", "author"]),
    last_edited_by:
      page?.last_edited_by?.name ||
      findPropertyValueByName(properties, ["last edited by", "edited by"]),
    doc_type: findPropertyValueByName(properties, ["type", "doc type", "document type"]),
    status: findPropertyValueByName(properties, ["status", "state"]),
    due_date: extractDueDate(properties),
    content,
    lastEditedTime: page?.last_edited_time ?? null,
  };
}

export async function syncNotionToPostgres(): Promise<SyncResult> {
  await ensureSchema();
  const notion = getNotionClient();
  const syncedAt = new Date().toISOString();

  const existingRows = await query<SyncRow>("SELECT id, synced_at FROM notion_pages");
  const existingSyncMap = new Map(existingRows.map((row) => [row.id, row.synced_at]));

  const pages = await fetchAllPages(notion);

  const pagesToSync: any[] = [];
  let skippedUnchanged = 0;

  for (const page of pages) {
    if (shouldSkipPage(page, existingSyncMap)) {
      skippedUnchanged += 1;
      continue;
    }
    pagesToSync.push(page);
  }

  let upserted = 0;
  let embeddingsFailed = 0;

  const totalChunks = Math.ceil(pagesToSync.length / SYNC_CHUNK_SIZE);
  console.log(
    `[sync] total_pages=${pages.length} to_sync=${pagesToSync.length} skipped_unchanged=${skippedUnchanged} chunks=${totalChunks}`,
  );

  for (let i = 0; i < pagesToSync.length; i += SYNC_CHUNK_SIZE) {
    const chunk = pagesToSync.slice(i, i + SYNC_CHUNK_SIZE);
    const chunkIndex = Math.floor(i / SYNC_CHUNK_SIZE) + 1;
    console.log(`[sync] chunk ${chunkIndex}/${totalChunks}: building records for ${chunk.length} pages`);

    const records: PageRecord[] = [];
    for (const page of chunk) {
      const record = await buildPageRecord(notion, page);
      records.push(record);
    }

    const embeddingInputs = records.map((record) =>
      buildEmbeddingText({
        title: record.title,
        owner: record.owner,
        created_by: record.created_by,
        last_edited_by: record.last_edited_by,
        doc_type: record.doc_type,
        status: record.status,
        content: record.content,
      }),
    );
    const embeddings = await embedBatch(embeddingInputs);

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const embedding = embeddings[index];
      if (!embedding) embeddingsFailed += 1;

      await query(
        `
        INSERT INTO notion_pages (
          id, title, url, owner, created_by, last_edited_by,
          doc_type, status, due_date, content, embedding, synced_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11::vector, $12::timestamptz
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
          synced_at = EXCLUDED.synced_at
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
          toVectorLiteral(embedding),
          syncedAt,
        ],
      );

      upserted += 1;
    }

    console.log(
      `[sync] chunk ${chunkIndex}/${totalChunks} done: upserted_so_far=${upserted} embeddings_failed_so_far=${embeddingsFailed}`,
    );
  }

  return {
    totalPages: pages.length,
    upserted,
    skippedUnchanged,
    embeddingsFailed,
    synced_at: syncedAt,
  };
}
