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

console.log("✅ Using Notion token:", process.env.NOTION_TOKEN.slice(0, 15) + "...");
console.log("✅ Using S3 bucket:", process.env.S3_BUCKET_NAME);
console.log("");

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
   HELPER: Extract Text from Blocks
-------------------- */
function extractText(block: any): string {
  const type = block.type;
  
  // Handle code blocks with syntax highlighting info
  if (type === 'code') {
    const rt = block.code?.rich_text;
    if (!rt) return "";
    const code = rt.map((t: any) => t.plain_text).join("");
    const language = block.code?.language || 'text';
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  
  // Handle equations
  if (type === 'equation') {
    return `Equation: ${block.equation?.expression || ''}`;
  }
  
  // Handle table rows
  if (type === 'table_row') {
    const cells = block.table_row?.cells || [];
    return cells.map((cell: any[]) => 
      cell.map((t: any) => t.plain_text).join('')
    ).join(' | ');
  }
  
  // Handle numbered lists
  if (type === 'numbered_list_item') {
    const rt = block.numbered_list_item?.rich_text;
    if (!rt) return "";
    return rt.map((t: any) => t.plain_text).join("");
  }
  
  // Handle bulleted lists
  if (type === 'bulleted_list_item') {
    const rt = block.bulleted_list_item?.rich_text;
    if (!rt) return "";
    return "• " + rt.map((t: any) => t.plain_text).join("");
  }
  
  // Handle to-do lists
  if (type === 'to_do') {
    const rt = block.to_do?.rich_text;
    const checked = block.to_do?.checked ? '[x]' : '[ ]';
    if (!rt) return "";
    return `${checked} ${rt.map((t: any) => t.plain_text).join("")}`;
  }
  
  // Handle toggle blocks
  if (type === 'toggle') {
    const rt = block.toggle?.rich_text;
    if (!rt) return "";
    return "▶ " + rt.map((t: any) => t.plain_text).join("");
  }
  
  // Handle quotes
  if (type === 'quote') {
    const rt = block.quote?.rich_text;
    if (!rt) return "";
    return "> " + rt.map((t: any) => t.plain_text).join("");
  }
  
  // Handle callouts
  if (type === 'callout') {
    const rt = block.callout?.rich_text;
    const icon = block.callout?.icon?.emoji || '💡';
    if (!rt) return "";
    return `${icon} ${rt.map((t: any) => t.plain_text).join("")}`;
  }
  
  // Handle media blocks with captions
  if (type === 'image') {
    const caption = block.image?.caption?.map((t: any) => t.plain_text).join('') || '';
    const url = block.image?.file?.url || block.image?.external?.url || '';
    return caption ? `[Image: ${caption}]` : `[Image: ${url}]`;
  }
  
  if (type === 'video') {
    const caption = block.video?.caption?.map((t: any) => t.plain_text).join('') || '';
    const url = block.video?.file?.url || block.video?.external?.url || '';
    return caption ? `[Video: ${caption}]` : `[Video: ${url}]`;
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
  
  // Skip unsupported blocks silently
  if (type === 'unsupported' || type === 'transcription' || type === 'synced_block') {
    return '';
  }
  
  // Handle headings with proper formatting
  if (type === 'heading_1') {
    const rt = block.heading_1?.rich_text;
    if (!rt) return "";
    return "# " + rt.map((t: any) => t.plain_text).join("");
  }
  
  if (type === 'heading_2') {
    const rt = block.heading_2?.rich_text;
    if (!rt) return "";
    return "## " + rt.map((t: any) => t.plain_text).join("");
  }
  
  if (type === 'heading_3') {
    const rt = block.heading_3?.rich_text;
    if (!rt) return "";
    return "### " + rt.map((t: any) => t.plain_text).join("");
  }
  
  // Default: extract rich_text from standard blocks (paragraph, etc.)
  const rt = block?.[type]?.rich_text;
  if (!rt) return "";
  return rt.map((t: any) => t.plain_text).join("");
}

/* --------------------
   HELPER: Extract Property Values
-------------------- */
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

/* --------------------
   HELPER: Fetch All Blocks Recursively
-------------------- */
async function fetchBlocksRecursively(blockId: string, depth: number = 0): Promise<string[]> {
  let texts: string[] = [];
  let cursor: string | undefined = undefined;
  const indent = "  ".repeat(depth); // For nested content visualization

  do {
    try {
      const res = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      });

      for (const block of res.results) {
        const text = extractText(block);
        if (text) {
          // Add indentation for nested content
          texts.push(indent + text);
        }

        // Recursively fetch child blocks
        if ("has_children" in block && block.has_children) {
          try {
            const childTexts = await fetchBlocksRecursively(block.id, depth + 1);
            texts.push(...childTexts);
          } catch (childError: any) {
            // Skip unsupported child blocks
            if (childError.code === 'validation_error') {
              console.warn(`   ⚠️  Skipping unsupported child block: ${childError.message}`);
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
        console.warn(`   ⚠️  Skipping unsupported block type: ${error.message}`);
        break;
      } else {
        throw error;
      }
    }
  } while (cursor);

  return texts;
}

/* --------------------
   HELPER: Upload to S3
-------------------- */
async function uploadToS3(key: string, data: any) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
  console.log(`   ✅ Uploaded to S3: ${key}`);
}

/* --------------------
   HELPER: Get Page Title
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
   MAIN EXPORT FUNCTION
-------------------- */
async function run() {
  console.log("🚀 Starting Notion Export to S3");
  console.log("=" .repeat(70));
  console.log("");

  let cursor: string | undefined = undefined;
  let total = 0;
  let failed = 0;
  const exportedPages: string[] = [];

  do {
    const res = await notion.search({
      page_size: 100,
      start_cursor: cursor,
    });

    for (const item of res.results) {
      // Only process pages
      if (item.object !== "page") continue;
      if (!("last_edited_time" in item)) continue;

      const pageId = item.id;
      const title = getPageTitle(item);

      console.log(`\n📄 Processing: "${title}"`);
      console.log(`   ID: ${pageId}`);

      try {
        // Fetch all content blocks recursively
        console.log(`   🔍 Fetching content blocks...`);
        const contentBlocks = await fetchBlocksRecursively(pageId);
        console.log(`   ✅ Found ${contentBlocks.length} content blocks`);

        // Build enriched content with clear document identification
        let enrichedContent = "";
        
        // === DOCUMENT HEADER (for identification) ===
        enrichedContent += `=== DOCUMENT START ===\n`;
        enrichedContent += `DOCUMENT_ID: ${pageId}\n`;
        enrichedContent += `DOCUMENT_TITLE: ${title}\n`;
        enrichedContent += `DOCUMENT_URL: ${item.url}\n`;
        enrichedContent += `\n`;
        
        // === METADATA SECTION ===
        enrichedContent += `=== METADATA ===\n`;
        
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
        
        enrichedContent += `\n`;
        
        // === PROPERTIES SECTION ===
        if (item.properties) {
          const props: string[] = [];
          
          for (const [key, val] of Object.entries(item.properties)) {
            // Skip title property as it's already included
            if ((val as any).type === 'title') continue;
            
            const value = extractPropertyValue(val as any);
            if (value) {
              props.push(`${key}: ${value}`);
            }
          }
          
          if (props.length) {
            enrichedContent += `=== PROPERTIES ===\n`;
            enrichedContent += props.join('\n') + '\n\n';
          }
        }
        
        // === MAIN CONTENT SECTION ===
        enrichedContent += `=== CONTENT ===\n`;
        enrichedContent += `[DOCUMENT: ${title}]\n\n`;
        
        if (contentBlocks.length) {
          enrichedContent += contentBlocks.join("\n");
        } else {
          enrichedContent += `This is a Notion page titled "${title}". No detailed content available.`;
        }
        
        enrichedContent += `\n\n`;
        
        // === DOCUMENT FOOTER ===
        enrichedContent += `=== DOCUMENT END ===\n`;
        enrichedContent += `[End of ${title}]\n`;

        // Create payload for S3
        const payload = {
          id: pageId,
          title,
          content: enrichedContent,
          lastEdited: item.last_edited_time,
          source: "notion",
          url: item.url,
          exportedAt: new Date().toISOString(),
        };

        // Upload to S3
        const s3Key = `notion/pages/${pageId}.json`;
        await uploadToS3(s3Key, payload);

        total++;
        exportedPages.push(title);
        
      } catch (pageError: any) {
        console.error(`   ❌ Failed to export: ${pageError.message}`);
        failed++;
        // Continue with next page
        continue;
      }
    }

    cursor = res.has_more ? res.next_cursor! : undefined;
  } while (cursor);

  // Final Summary
  console.log("\n" + "=".repeat(70));
  console.log("📊 EXPORT SUMMARY");
  console.log("=".repeat(70));
  console.log(`✅ Successfully exported: ${total} pages`);
  console.log(`❌ Failed to export: ${failed} pages`);
  console.log(`📁 S3 Bucket: ${BUCKET}`);
  console.log(`📂 S3 Path: notion/pages/`);
  console.log("");
  
  if (exportedPages.length > 0) {
    console.log("📋 Exported Pages:");
    exportedPages.forEach((title, index) => {
      console.log(`   ${index + 1}. ${title}`);
    });
  }
  
  console.log("\n✅ Export completed successfully!");
}

// Run the export
run().catch((err) => {
  console.error("\n❌ Export failed with error:");
  console.error(err);
  process.exit(1);
});