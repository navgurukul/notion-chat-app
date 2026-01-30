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
  const type = block.type;
  
  // Handle different block types
  if (type === 'code') {
    const rt = block.code?.rich_text;
    if (!rt) return "";
    const code = rt.map((t: any) => t.plain_text).join("");
    return `\`\`\`${block.code?.language || ''}\n${code}\n\`\`\``;
  }
  
  if (type === 'equation') {
    return `Equation: ${block.equation?.expression || ''}`;
  }
  
  if (type === 'table_row') {
    const cells = block.table_row?.cells || [];
    return cells.map((cell: any[]) => 
      cell.map((t: any) => t.plain_text).join('')
    ).join(' | ');
  }
  
  // Handle media blocks
  if (type === 'image') {
    const caption = block.image?.caption?.map((t: any) => t.plain_text).join('') || '';
    return caption ? `[Image: ${caption}]` : '[Image]';
  }
  
  if (type === 'video') {
    const caption = block.video?.caption?.map((t: any) => t.plain_text).join('') || '';
    return caption ? `[Video: ${caption}]` : '[Video]';
  }
  
  if (type === 'file') {
    const caption = block.file?.caption?.map((t: any) => t.plain_text).join('') || '';
    const name = block.file?.name || 'file';
    return caption ? `[File: ${name} - ${caption}]` : `[File: ${name}]`;
  }
  
  if (type === 'pdf') {
    const caption = block.pdf?.caption?.map((t: any) => t.plain_text).join('') || '';
    return caption ? `[PDF: ${caption}]` : '[PDF]';
  }
  
  if (type === 'bookmark') {
    const url = block.bookmark?.url || '';
    const caption = block.bookmark?.caption?.map((t: any) => t.plain_text).join('') || '';
    return caption ? `[Bookmark: ${caption} - ${url}]` : `[Bookmark: ${url}]`;
  }
  
  if (type === 'embed') {
    const url = block.embed?.url || '';
    return `[Embed: ${url}]`;
  }
  
  if (type === 'audio') {
    const caption = block.audio?.caption?.map((t: any) => t.plain_text).join('') || '';
    return caption ? `[Audio: ${caption}]` : '[Audio]';
  }
  
  if (type === 'link_preview') {
    const url = block.link_preview?.url || '';
    return `[Link: ${url}]`;
  }
  
  if (type === 'divider') {
    return '---';
  }
  
  if (type === 'table_of_contents') {
    return '[Table of Contents]';
  }
  
  if (type === 'breadcrumb') {
    return '[Breadcrumb]';
  }
  
  // Unsupported or unknown block types - return empty string to avoid crash
  if (type === 'unsupported' || type === 'transcription' || type === 'synced_block') {
    return '';
  }
  
  // Default rich_text extraction for standard blocks
  const rt = block?.[type]?.rich_text;
  if (!rt) return "";
  return rt.map((t: any) => t.plain_text).join("");
}

function extractPropertyValue(prop: any): string | null {
  if (!prop) return null;
  
  switch (prop.type) {
    case 'title':
      return prop.title?.map((t: any) => t.plain_text).join('') || null;
    case 'rich_text':
      return prop.rich_text?.map((t: any) => t.plain_text).join('') || null;
    case 'number':
      return prop.number?.toString() || null;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select?.map((s: any) => s.name).join(', ') || null;
    case 'date':
      if (prop.date?.start) {
        const end = prop.date?.end ? ` to ${prop.date.end}` : '';
        return `${prop.date.start}${end}`;
      }
      return null;
    case 'people':
      return prop.people?.map((p: any) => p.name || p.id).join(', ') || null;
    case 'files':
      return prop.files?.map((f: any) => f.name || 'file').join(', ') || null;
    case 'checkbox':
      return prop.checkbox ? 'Yes' : 'No';
    case 'url':
      return prop.url || null;
    case 'email':
      return prop.email || null;
    case 'phone_number':
      return prop.phone_number || null;
    case 'formula':
      return extractPropertyValue(prop.formula) || null;
    case 'relation':
      return prop.relation?.length ? `${prop.relation.length} linked items` : null;
    case 'rollup':
      return extractPropertyValue(prop.rollup) || null;
    case 'created_time':
      return prop.created_time || null;
    case 'created_by':
      return prop.created_by?.name || prop.created_by?.id || null;
    case 'last_edited_time':
      return prop.last_edited_time || null;
    case 'last_edited_by':
      return prop.last_edited_by?.name || prop.last_edited_by?.id || null;
    case 'status':
      return prop.status?.name || null;
    default:
      return null;
  }
}

async function fetchBlocksRecursively(blockId: string): Promise<string[]> {
  let texts: string[] = [];
  let cursor: string | undefined = undefined;

  do {
    try {
      const res = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      });

      for (const block of res.results) {
        const text = extractText(block);
        if (text) texts.push(text);

        if ("has_children" in block && block.has_children) {
          try {
            const childTexts = await fetchBlocksRecursively(block.id);
            texts.push(...childTexts);
          } catch (childError: any) {
            // Skip unsupported child blocks
            if (childError.code === 'validation_error') {
              console.warn(`⚠️  Skipping unsupported child block: ${childError.message}`);
            } else {
              throw childError;
            }
          }
        }
      }

      cursor = res.has_more ? res.next_cursor! : undefined;
    } catch (error: any) {
      // Skip unsupported blocks but log the warning
      if (error.code === 'validation_error' && error.message.includes('not supported via the API')) {
        console.warn(`⚠️  Skipping unsupported block type: ${error.message}`);
        break; // Stop processing this branch but continue with the page
      } else {
        throw error; // Re-throw other errors
      }
    }
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
      if (!("last_edited_time" in item)) continue;

      const pageId = item.id;
      const title = getPageTitle(item);

      console.log(`📄 Exporting: ${title}`);

      try {
        const contentBlocks = await fetchBlocksRecursively(pageId);

        // Build enriched content that includes title for better embedding
        let enrichedContent = `Title: ${title}\n\n`;
        
        // Add page metadata (created by, created time, etc.)
        if ('created_by' in item) {
          const createdBy = item.created_by?.type === 'person' 
            ? (item.created_by as any).person?.name || (item.created_by as any).name || (item.created_by as any).id
            : 'Unknown';
          enrichedContent += `Created by: ${createdBy}\n`;
        }
        if ('created_time' in item) {
          enrichedContent += `Created on: ${new Date(item.created_time).toLocaleDateString()}\n`;
        }
        if ('last_edited_by' in item) {
          const editedBy = item.last_edited_by?.type === 'person'
            ? (item.last_edited_by as any).person?.name || (item.last_edited_by as any).name || (item.last_edited_by as any).id
            : 'Unknown';
          enrichedContent += `Last edited by: ${editedBy}\n`;
        }
        if ('last_edited_time' in item) {
          enrichedContent += `Last edited: ${new Date(item.last_edited_time).toLocaleDateString()}\n`;
        }
        
        enrichedContent += '\n';
        
        // Add ALL properties
        if (item.properties) {
          const props: string[] = [];
          
          for (const [key, val] of Object.entries(item.properties)) {
            const value = extractPropertyValue(val as any);
            if (value) {
              props.push(`${key}: ${value}`);
            }
          }
          
          if (props.length) {
            enrichedContent += props.join('\n') + '\n\n';
          }
        }
        
        // Add content blocks
        if (contentBlocks.length) {
          enrichedContent += contentBlocks.join("\n");
        } else {
          // For pages with no content, add a default description
          enrichedContent += `This is a Notion page titled "${title}". No detailed content available.`;
        }

        const payload = {
          id: pageId,
          title,
          content: enrichedContent,
          lastEdited: item.last_edited_time,
          source: "notion",
          url: item.url,
        };

        const s3Key = `notion/pages/${pageId}.json`;
        await uploadToS3(s3Key, payload);

        total++;
      } catch (pageError: any) {
        console.error(`❌ Failed to export page "${title}": ${pageError.message}`);
        // Continue with next page instead of stopping entire export
        continue;
      }
    }

    cursor = res.has_more ? res.next_cursor! : undefined;
  } while (cursor);

  console.log(`✅ Export completed. Total pages exported: ${total}`);
}

run().catch((err) => {
  console.error("❌ Export failed:", err);
  process.exit(1);
});
