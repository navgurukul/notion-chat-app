import { Client } from "@notionhq/client";

//  Your existing working function - UNCHANGED
export async function getPageContext(pageId: string) {
  if (!process.env.NOTION_TOKEN) {
    throw new Error("NOTION_TOKEN is not configured");
  }

  const notion = new Client({
    auth: process.env.NOTION_TOKEN,
  });

  // 1️⃣ Get page metadata
  const page: any = await notion.pages.retrieve({ page_id: pageId });

  const title =
    page.properties?.Name?.title?.map((t: any) => t.plain_text).join("") ||
    "Untitled";

  const owner =
    page.properties?.Owner?.people?.map((p: any) => p.name).join(", ") ||
    "Not specified";

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

// 🚀 NEW: Get all documents from All Docs database
export async function getAllDocuments() {
  try {
    if (!process.env.NOTION_TOKEN) {
      throw new Error("NOTION_TOKEN is not configured");
    }

    const notion = new Client({
      auth: process.env.NOTION_TOKEN,
    });

    // ✅ Use environment variable instead of hardcoded ID
    const allDocsResponse = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID!,
      page_size: 100,
    });

    // Extract document metadata
    const documents = allDocsResponse.results.map((page: any) => {
      const properties = page.properties;

      return {
        id: page.id,
        title: properties?.Name?.title?.[0]?.plain_text || "Untitled",
        owner:
          properties?.Owner?.people?.map((p: any) => p.name).join(", ") ||
          "Not specified",
        type: properties?.Type?.select?.name || "Unknown",
        product: properties?.Product?.select?.name || "None",
        createdBy: properties?.["Created by"]?.created_by?.name || "Unknown",
        createdDate: page.created_time,
      };
    });

    console.log(`📚 Found ${documents.length} documents in database`);
    return documents;
  } catch (error) {
    console.error("❌ Error fetching all documents:", error);
    throw error;
  }
}

// 🚀 NEW: Smart question matching to find relevant documents
export function findRelevantDocuments(documents: any[], userQuestion: string) {
  const keywords = userQuestion.toLowerCase().split(" ");

  const scoredDocuments = documents.map((doc) => {
    const searchableText = [
      doc.title,
      doc.owner,
      doc.type,
      doc.product,
      doc.createdBy,
    ]
      .join(" ")
      .toLowerCase();

    // Count keyword matches
    let score = 0;
    keywords.forEach((keyword) => {
      if (searchableText.includes(keyword)) {
        score += 1;
      }
    });

    return { ...doc, score };
  });

  // Return top 3 most relevant documents (only those with matches)
  const relevant = scoredDocuments
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  console.log(
    `🎯 Found ${relevant.length} relevant documents for: "${userQuestion}"`
  );
  return relevant;
}

// 🚀 NEW: Get context from multiple documents
export async function getMultiDocumentContext(documentIds: string[]) {
  const contexts = [];

  for (const docId of documentIds) {
    try {
      const context = await getPageContext(docId);
      contexts.push(context);
    } catch (error) {
      console.error(` Failed to fetch document ${docId}:`, error);
    }
  }

  return contexts.join("\n\n--- NEXT DOCUMENT ---\n\n");
}

// 🚀 Smart context builder that always uses all document data
export async function getSmartContext(userQuestion: string) {
  try {
    // Step 1: Get all available documents
    const allDocs = await getAllDocuments();

    // Step 2: Find relevant documents based on user question
    const relevantDocs = findRelevantDocuments(allDocs, userQuestion);

    // Step 3: Always use relevant documents (no fallback)
    if (relevantDocs.length > 0) {
      const relevantIds = relevantDocs.map((doc) => doc.id);
      console.log(
        `📋 Using ${relevantDocs.length} relevant documents: ${relevantDocs
          .map((d) => d.title)
          .join(", ")}`
      );
      return await getMultiDocumentContext(relevantIds);
    } else {
      // If no matches, return a message indicating no relevant documents found
      console.log(`📋 No relevant documents found for: "${userQuestion}"`);
      return `I couldn't find any documents relevant to your question: "${userQuestion}". 

Available documents in our database include:
${allDocs
  .map((doc) => `• ${doc.title}`)
  .slice(0, 10)
  .join("\n")}
${allDocs.length > 10 ? `\n... and ${allDocs.length - 10} more documents` : ""}

Try asking about specific topics, people, or projects mentioned in these documents.`;
    }
  } catch (error) {
    console.error(" Error in smart context:", error);
    throw error; // Let the error bubble up instead of using fallback
  }
}
