
 
import { Client } from "@notionhq/client";

export async function getPageContext(pageId: string) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error("NOTION_TOKEN is not configured");
  }

  const notion = new Client({
    auth: process.env.NOTION_TOKEN,
  });

  // 1️⃣ Get page metadata
  const page = await notion.pages.retrieve({ page_id: pageId });

  const title =
    page.properties?.Name?.title
      ?.map((t: any) => t.plain_text)
      .join("") || "Untitled";

  const owner =
    page.properties?.Owner?.people
      ?.map((p: any) => p.name)
      .join(", ") || "Not specified";

  const createdDate = new Date(page.created_time).toLocaleString();

  // 2️⃣ Get page content (blocks)
  const blocks = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  const pageContent = blocks.results
    .map((block: any) => {
      const type = block.type;
      const richText = block[type]?.rich_text;
      if (!richText) return "";

      return richText.map((t: any) => t.plain_text).join("");
    })
    .filter(Boolean)
    .join("\n");

  // 3️⃣ Build FINAL context (this is what Gemini sees)
  const context = `
DOCUMENT METADATA
Title: ${title}
Owner: ${owner}
Created date: ${createdDate}

DOCUMENT CONTENT
${pageContent}
`;

  return context;
}

