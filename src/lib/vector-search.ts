/**
 * Semantic Search — Layer 2
 *
 * Primary:  pgvector cosine similarity (when embeddings exist)
 * Fallback: PostgreSQL full-text search (when embeddings not yet generated)
 */

import { query } from "./postgres";
import { embedText } from "./embeddings";

type SearchResult = {
  id: string;
  title: string | null;
  url: string | null;
  content: string | null;
  similarity: number;
};

const DEFAULT_TOP_K = parseInt(process.env.VECTOR_SEARCH_TOP_K ?? "20", 10);
const DEFAULT_MIN_SIMILARITY = parseFloat(process.env.VECTOR_SEARCH_MIN_SIMILARITY ?? "0.3");
const DEFAULT_MAX_CONTEXT_CHARS = parseInt(process.env.VECTOR_SEARCH_MAX_CONTEXT_CHARS ?? "24000", 10);

async function hasEmbeddings(): Promise<boolean> {
  const rows = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM notion_pages WHERE embedding IS NOT NULL LIMIT 1",
  );
  return parseInt(rows[0]?.count ?? "0", 10) > 0;
}

async function vectorSearch(questionText: string): Promise<SearchResult[]> {
  const embedding = await embedText(questionText);
  const vectorLiteral = `[${embedding.join(",")}]`;

  return query<SearchResult>(
    `SELECT id, title, url, content,
            1 - (embedding <=> $1::vector) AS similarity
     FROM notion_pages
     WHERE embedding IS NOT NULL
       AND 1 - (embedding <=> $1::vector) >= $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral, DEFAULT_MIN_SIMILARITY, DEFAULT_TOP_K],
  );
}

async function fullTextSearch(questionText: string): Promise<SearchResult[]> {
  return query<SearchResult>(
    `SELECT id, title, url,
            left(content, 3000) AS content,
            (
              ts_rank(to_tsvector('english', coalesce(title,'')), plainto_tsquery('english', $1)) * 2 +
              ts_rank(to_tsvector('english', coalesce(content,'')), plainto_tsquery('english', $1))
            ) AS similarity
     FROM notion_pages
     WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
           @@ plainto_tsquery('english', $1)
     ORDER BY similarity DESC
     LIMIT $2`,
    [questionText, DEFAULT_TOP_K],
  );
}

function buildContext(results: SearchResult[]): string {
  const maxChars = DEFAULT_MAX_CONTEXT_CHARS;
  let totalChars = 0;
  const parts: string[] = [];

  for (const row of results) {
    const header = [
      row.title ? `Title: ${row.title}` : null,
      row.url ? `URL: ${row.url}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const body = row.content ?? "";
    const chunk = `${header}\n\n${body}`;

    if (parts.length > 0 && totalChars + chunk.length > maxChars) break;
    parts.push(chunk);
    totalChars += chunk.length;
  }

  return parts.join("\n\n---\n\n");
}

export async function semanticSearch(questionText: string): Promise<string> {
  try {
    const embeddingsAvailable = await hasEmbeddings();

    if (embeddingsAvailable) {
      const results = await vectorSearch(questionText);
      if (results.length > 0) return buildContext(results);
    }

    // Fallback to full-text search
    if (process.env.NODE_ENV !== "production") {
      console.log("[search] using full-text fallback");
    }
    const results = await fullTextSearch(questionText);
    return buildContext(results);
  } catch (error) {
    console.error("Search error:", error);
    return "";
  }
}
