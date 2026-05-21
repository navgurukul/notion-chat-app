const CHUNK_WORDS = 400;
const OVERLAP_WORDS = 50;

export type PageChunkInput = {
  id: string;
  title: string;
  content: string;
  owner?: string | null;
  status?: string | null;
  doc_type?: string | null;
  created_by?: string | null;
  last_edited_by?: string | null;
};

function buildChunkPrefix(page: PageChunkInput): string {
  const meta = [
    page.owner ? `Owner: ${page.owner}` : "",
    page.status ? `Status: ${page.status}` : "",
    page.doc_type ? `Type: ${page.doc_type}` : "",
    page.created_by ? `Created by: ${page.created_by}` : "",
    page.last_edited_by ? `Last edited by: ${page.last_edited_by}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return meta ? `${page.title}\n${meta}` : page.title;
}

export type PageChunk = {
  page_id: string;
  chunk_index: number;
  section_heading: string | null;
  content: string;
};

/**
 * Word-window chunking with overlap. Each chunk is prefixed with the page title
 * so embeddings carry document identity.
 */
export function chunkPageContent(page: PageChunkInput): PageChunk[] {
  const raw = (page.content || "").trim();
  const words = raw.length ? raw.split(/\s+/).filter(Boolean) : [];

  if (words.length === 0) {
    return [
      {
        page_id: page.id,
        chunk_index: 0,
        section_heading: null,
        content: `${buildChunkPrefix(page)}\n(No body text synced for this page.)`,
      },
    ];
  }

  const chunks: PageChunk[] = [];
  let i = 0;
  let index = 0;
  const step = Math.max(1, CHUNK_WORDS - OVERLAP_WORDS);

  while (i < words.length) {
    const slice = words.slice(i, i + CHUNK_WORDS).join(" ");
    const nl = slice.indexOf("\n");
    const firstLine = (nl === -1 ? slice : slice.slice(0, nl)).trim();
    const section_heading =
      firstLine.length > 0 && firstLine.length < 80 ? firstLine : null;

    chunks.push({
      page_id: page.id,
      chunk_index: index,
      section_heading,
      content: `${buildChunkPrefix(page)}\n${slice}`,
    });

    index += 1;
    i += step;
  }

  return chunks;
}
