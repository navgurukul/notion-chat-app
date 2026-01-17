import { Client } from "@notionhq/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as dotenv from "dotenv";

dotenv.config();

/* --------------------
   ENV VALIDATION
-------------------- */
if (!process.env.NOTION_TOKEN) {
  throw new Error("❌ NOTION_TOKEN missing in .env");
}
if (!process.env.S3_BUCKET_NAME) {
  throw new Error("❌ S3_BUCKET_NAME missing in .env");
}

console.log("Using Notion token:", process.env.NOTION_TOKEN.slice(0, 10));

/* --------------------
   CLIENTS
-------------------- */
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
});

const BUCKET = process.env.S3_BUCKET_NAME;

/* --------------------
   HELPERS
-------------------- */
function extractText(block: any): string {
  const rt = block?.[block.type]?.rich_text;
  if (!rt) return "";
  return rt.map((t: any) => t.plain_text).join("");
}

async function fetchBlocksRecursively(blockId: string): Promise<string[]> {
  let texts: string[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      const text = extractText(block);
      if (text) texts.push(text);

      if (block.has_children) {
        const childTexts = await fetchBlocksRecursively(block.id);
        texts.push(...childTexts);
      }
    }

    cursor = res.has_more ? res.next_cursor! : undefined;
  } while (cursor);

  return texts;
}

async function uploadToS3(key: string, data: any) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

/* --------------------
   TITLE EXTRACTION
-------------------- */
function getPageTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key].type === "title") {
      return props[key].title?.[0]?.plain_text || "Untitled";
    }
  }
  return "Untitled";
}

/* --------------------
   MAIN EXPORT
-------------------- */
async function run() {
  console.log("🔍 Searching entire Notion workspace...");

  let cursor: string | undefined = undefined;
  let total = 0;

  do {
    const res = await notion.search({
      page_size: 100,
      start_cursor: cursor,
    });

    for (const item of res.results) {
      if (item.object !== "page") continue;

      const pageId = item.id;
      const title = getPageTitle(item);

      console.log(`📄 Exporting: ${title}`);

      const contentBlocks = await fetchBlocksRecursively(pageId);

      if (!contentBlocks.length) continue;

      const payload = {
        id: pageId,
        title,
        content: contentBlocks.join("\n"),
        lastEdited: item.last_edited_time,
        source: "notion",
        url: item.url,
      };

      const s3Key = `notion/pages/${pageId}.json`;
      await uploadToS3(s3Key, payload);

      total++;
    }

    cursor = res.has_more ? res.next_cursor! : undefined;
  } while (cursor);

  console.log(`✅ Export completed. Total pages exported: ${total}`);
}

run().catch((err) => {
  console.error("❌ Export failed:", err);
  process.exit(1);
});
