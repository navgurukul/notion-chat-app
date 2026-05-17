/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client } from "@notionhq/client";
import { chunkPageContent } from "@/lib/chunk-page";
import { buildEmbeddingText, embedBatch } from "@/lib/embeddings";
import { ensureSchema, query } from "@/lib/postgres";

const PAGE_SIZE = 100;
const SYNC_CHUNK_SIZE = 20;
const DEFAULT_PAGE_BUILD_CONCURRENCY = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "fetch_failed",
]);

export type SyncResult = {
  totalPages: number;
  upserted: number;
  skippedUnchanged: number;
  failedPages: number;
  embeddingsFailed: number;
  synced_at: string;
};

type SyncRow = {
  id: string;
  synced_at: string;
  has_embedding: boolean;
  has_rich_content: boolean;
};

type SyncOptions = {
  force?: boolean;
  embed?: boolean;
  refreshContent?: boolean;
  limit?: number;
};

function readSyncLimit(options: SyncOptions): number | undefined {
  if (options.limit != null && options.limit > 0) return options.limit;
  const parsed = Number.parseInt(process.env.SYNC_PAGE_LIMIT ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return undefined;
}

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

function getPageBuildConcurrency() {
  const parsed = Number.parseInt(process.env.NOTION_SYNC_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_BUILD_CONCURRENCY;
  return Math.min(parsed, 5);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function isRetryableNotionError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number; statusCode?: number }).status ??
    (error as { status?: number; statusCode?: number }).statusCode;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) return true;

  const code = String((error as { code?: string }).code ?? "");
  if (
    code === "rate_limited" ||
    code === "service_unavailable" ||
    code === "internal_server_error" ||
    RETRYABLE_NETWORK_CODES.has(code)
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ETIMEDOUT|socket|network|fetch failed|terminated/i.test(message);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 6,
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
      const delayMs = 750 * 2 ** (attempt - 1);
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
    case "files":
      return prop.files?.map((item: any) => item?.name || item?.file?.url || item?.external?.url).filter(Boolean).join(", ") || null;
    case "formula":
      return extractPropertyValue(prop.formula) || null;
    case "relation":
      return prop.relation?.length ? `${prop.relation.length} linked item(s)` : null;
    case "rollup":
      return extractPropertyValue(prop.rollup) || null;
    case "created_time":
      return prop.created_time ?? null;
    case "created_by":
      return prop.created_by?.name || prop.created_by?.id || null;
    case "last_edited_time":
      return prop.last_edited_time ?? null;
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

  if (type === "table_row") {
    const cells = block.table_row?.cells || [];
    return cells
      .map((cell: any[]) => cell.map((item: any) => item?.plain_text ?? "").join(""))
      .join(" | ")
      .trim();
  }

  if (type === "code") {
    const code = getTextFromRichText(block.code?.rich_text);
    const language = block.code?.language || "text";
    return code ? `\`\`\`${language}\n${code}\n\`\`\`` : "";
  }

  if (type === "equation") return block.equation?.expression ? `Equation: ${block.equation.expression}` : "";
  if (type === "divider") return "---";
  if (type === "table_of_contents") return "[Table of Contents]";
  if (type === "breadcrumb") return "[Breadcrumb]";
  if (type === "child_database") return block.child_database?.title ? `[Database: ${block.child_database.title}]` : "[Database]";
  if (type === "child_page") return block.child_page?.title ? `[Page: ${block.child_page.title}]` : "[Page]";

  const rich = block?.[type]?.rich_text;
  const text = getTextFromRichText(rich).trim();

  if (type === "heading_1") return `# ${text}`;
  if (type === "heading_2") return `## ${text}`;
  if (type === "heading_3") return `### ${text}`;
  if (type === "bulleted_list_item") return `- ${text}`;
  if (type === "numbered_list_item") return `1. ${text}`;
  if (type === "to_do") return `${block?.to_do?.checked ? "[x]" : "[ ]"} ${text}`;
  if (type === "quote") return `> ${text}`;
  if (type === "callout") return text ? `${block.callout?.icon?.emoji || ""} ${text}`.trim() : "";
  if (type === "toggle") return text ? `> ${text}` : "";
  if (type === "image") {
    const caption = getTextFromRichText(block.image?.caption);
    const url = block.image?.file?.url || block.image?.external?.url || "";
    return caption ? `[Image: ${caption}]` : url ? `[Image: ${url}]` : "";
  }
  if (type === "video") {
    const caption = getTextFromRichText(block.video?.caption);
    const url = block.video?.file?.url || block.video?.external?.url || "";
    return caption ? `[Video: ${caption}]` : url ? `[Video: ${url}]` : "";
  }
  if (type === "file") {
    const caption = getTextFromRichText(block.file?.caption);
    const name = block.file?.name || block.file?.file?.url || block.file?.external?.url || "file";
    return caption ? `[File: ${name} - ${caption}]` : `[File: ${name}]`;
  }
  if (type === "pdf") {
    const caption = getTextFromRichText(block.pdf?.caption);
    return caption ? `[PDF: ${caption}]` : "[PDF]";
  }
  if (type === "bookmark") {
    const caption = getTextFromRichText(block.bookmark?.caption);
    const url = block.bookmark?.url || "";
    return caption ? `[Bookmark: ${caption} - ${url}]` : url ? `[Bookmark: ${url}]` : "";
  }
  if (type === "embed") return block.embed?.url ? `[Embed: ${block.embed.url}]` : "";
  if (type === "link_preview") return block.link_preview?.url ? `[Link: ${block.link_preview.url}]` : "";
  if (type === "audio") {
    const caption = getTextFromRichText(block.audio?.caption);
    return caption ? `[Audio: ${caption}]` : "[Audio]";
  }

  if (!text) return "";
  return text;
}

function buildPropertiesText(properties: Record<string, any>) {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value?.type === "title") continue;
    const parsed = extractPropertyValue(value);
    if (parsed?.trim()) lines.push(`${key}: ${parsed.trim()}`);
  }
  return lines;
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

async function replacePageChunks(record: PageRecord, shouldEmbed: boolean) {
  await query(`DELETE FROM notion_chunks WHERE page_id = $1`, [record.id]);

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

  const embeddings = shouldEmbed
    ? await embedBatch(chunks.map((chunk) => chunk.content))
    : chunks.map(() => null);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const embedding = embeddings[i];
    await query(
      `
      INSERT INTO notion_chunks (page_id, chunk_index, section_heading, content, embedding)
      VALUES ($1, $2, $3, $4, CAST($5 AS vector))
      `,
      [
        chunk.page_id,
        chunk.chunk_index,
        chunk.section_heading,
        chunk.content,
        toVectorLiteral(embedding),
      ],
    );
  }
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
  const propertyLines = buildPropertiesText(properties);
  const content = [
    `Title: ${title}`,
    page.url ? `URL: ${page.url}` : "",
    page?.created_by?.name ? `Created by: ${page.created_by.name}` : "",
    page?.last_edited_by?.name ? `Last edited by: ${page.last_edited_by.name}` : "",
    propertyLines.length ? "=== PROPERTIES ===" : "",
    ...propertyLines,
    "=== CONTENT ===",
    ...(contentLines.length ? contentLines : [`This is a Notion page titled "${title}".`]),
  ]
    .filter(Boolean)
    .join("\n");

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

export async function syncNotionToPostgres(options: SyncOptions = {}): Promise<SyncResult> {
  const shouldForce = options.force ?? false;
  const shouldEmbed = options.embed ?? true;
  const shouldRefreshContent = options.refreshContent ?? false;
  await ensureSchema();
  const notion = getNotionClient();
  const syncedAt = new Date().toISOString();

  const existingRows = await query<SyncRow>(
    `
    SELECT
      id,
      synced_at,
      embedding IS NOT NULL AS has_embedding,
      content LIKE '%=== CONTENT ===%' AS has_rich_content
    FROM notion_pages
    `,
  );
  const existingSyncMap = new Map(existingRows.map((row) => [row.id, row.synced_at]));
  const existingRowMap = new Map(existingRows.map((row) => [row.id, row]));

  const pages = await fetchAllPages(notion);

  const pagesToSync: any[] = [];
  let skippedUnchanged = 0;

  for (const page of pages) {
    const existingRow = existingRowMap.get(page.id);
    const hasFreshContent =
      shouldRefreshContent &&
      existingRow?.has_rich_content &&
      shouldSkipPage(page, existingSyncMap);

    if (
      !shouldForce &&
      (hasFreshContent || (!shouldRefreshContent && shouldSkipPage(page, existingSyncMap)))
    ) {
      skippedUnchanged += 1;
      continue;
    }
    pagesToSync.push(page);
  }

  const syncLimit = readSyncLimit(options);
  const pagesToProcess =
    syncLimit != null ? pagesToSync.slice(0, syncLimit) : pagesToSync;

  let upserted = 0;
  let embeddingsFailed = 0;
  let failedPages = 0;

  const totalChunks = Math.ceil(pagesToProcess.length / SYNC_CHUNK_SIZE);
  console.log(
    `[sync] total_pages=${pages.length} to_sync=${pagesToSync.length} processing=${pagesToProcess.length} limit=${syncLimit ?? "none"} skipped_unchanged=${skippedUnchanged} chunks=${totalChunks} force=${shouldForce} refresh_content=${shouldRefreshContent} embed=${shouldEmbed}`,
  );

  for (let i = 0; i < pagesToProcess.length; i += SYNC_CHUNK_SIZE) {
    const chunk = pagesToProcess.slice(i, i + SYNC_CHUNK_SIZE);
    const chunkIndex = Math.floor(i / SYNC_CHUNK_SIZE) + 1;
    console.log(`[sync] chunk ${chunkIndex}/${totalChunks}: building records for ${chunk.length} pages`);

    const recordResults = await mapWithConcurrency(
      chunk,
      getPageBuildConcurrency(),
      async (page): Promise<PageRecord | null> => {
        try {
          return await buildPageRecord(notion, page);
        } catch (error) {
          failedPages += 1;
          const title = getPageTitle(page);
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[sync] skipping page after failed content fetch: ${title} (${page.id}) - ${message}`);
          return null;
        }
      },
    );
    const records = recordResults.filter((record): record is PageRecord => Boolean(record));

    const embeddings = shouldEmbed
      ? await embedBatch(
          records.map((record) =>
            buildEmbeddingText({
              title: record.title,
              owner: record.owner,
              created_by: record.created_by,
              last_edited_by: record.last_edited_by,
              doc_type: record.doc_type,
              status: record.status,
              content: record.content,
            }),
          ),
        )
      : records.map(() => null);

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const embedding = embeddings[index];
      if (shouldEmbed && !embedding) embeddingsFailed += 1;

      await query(
        `
        INSERT INTO notion_pages (
          id, title, url, owner, created_by, last_edited_by,
          doc_type, status, due_date, content, embedding, synced_at, notion_edited_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11::vector, $12::timestamptz, $13::timestamptz
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
          embedding = COALESCE(EXCLUDED.embedding, notion_pages.embedding),
          synced_at = EXCLUDED.synced_at,
          notion_edited_at = COALESCE(EXCLUDED.notion_edited_at, notion_pages.notion_edited_at)
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
          record.lastEditedTime,
        ],
      );

      try {
        await replacePageChunks(record, shouldEmbed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[sync] chunk rows failed for page ${record.title} (${record.id}): ${message}`);
      }

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
    failedPages,
    embeddingsFailed,
    synced_at: syncedAt,
  };
}
