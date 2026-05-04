import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";

const DEFAULT_RESULTS_PER_QUERY = 10;
const DEFAULT_HIGH_RECALL_RESULTS_PER_QUERY = 25;
const DEFAULT_HIGH_RECALL_MAX_QUERIES = 6;
const DEFAULT_HIGH_RECALL_MAX_CHUNK_CHARS = 900;
const DEFAULT_MAX_CONTEXT_CHARS = 32000;

const client = new BedrockAgentRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
});

type RetrievedChunk = {
  text: string;
  score: number;
  source?: string;
};

type RetrievalContext = {
  context: string;
  chunkCount: number;
  retrievalQueryCount: number;
  sourceCount: number;
  mode: "standard" | "high-recall";
};

function readPositiveInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function extractCurrentQuestion(query: string) {
  const marker = "Current question:";
  const idx = query.lastIndexOf(marker);
  if (idx === -1) return query.trim();
  return query.slice(idx + marker.length).trim();
}

function isHighRecallPeopleListingQuery(question: string) {
  const q = question.trim();
  if (!q) return false;

  const explicitListOrCount =
    /\b(all|every|list|show me|show|total|count|number of|how many)\b/i.test(q);
  const peopleField =
    /\b(owner|owned by|created by|creator|author|written by|last edited by|edited by|assignees?|assigned to)\b/i.test(
      q,
    );
  const implicitList =
    /\b(docs?|documents?|pages?|notes?)\b/i.test(q) &&
    /\b(owned by|created by|assigned to)\b/i.test(q);

  return peopleField && (explicitListOrCount || implicitList);
}

function normalizeExtractedName(value: string) {
  return value
    .trim()
    .replace(/^[:\-\s]+/, "")
    .replace(/[?!.;,\s]+$/, "")
    .replace(/\s{2,}/g, " ");
}

function extractPersonNameForPeopleQuery(text: string): string | null {
  const candidatePatterns: RegExp[] = [
    /\bowned by\s+([^\n]+)$/i,
    /\bcreated by\s+([^\n]+)$/i,
    /\blast edited by\s+([^\n]+)$/i,
    /\bassigned to\s+([^\n]+)$/i,
    /\bowner\s*[:\-]\s*([^\n]+)$/i,
    /\bcreator\s*[:\-]\s*([^\n]+)$/i,
    /\bauthor\s*[:\-]\s*([^\n]+)$/i,
    /\bby\s+([A-Za-z][\w'.-]+(?:\s+[A-Za-z][\w'.-]+){1,3})\b/i,
  ];

  for (const pattern of candidatePatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const name = normalizeExtractedName(match[1]);
    if (!name) continue;

    // Avoid capturing obvious non-name tails.
    if (/\b(docs?|documents?|pages?|notes?|in notion|in our notion|please|thanks)\b/i.test(name)) {
      continue;
    }

    return name;
  }

  return null;
}

function extractLastMentionedPersonName(text: string): string | null {
  const candidates = Array.from(
    text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g),
  ).map((match) => match[1]);

  if (candidates.length === 0) return null;

  const blacklist = new Set([
    "Conversation context",
    "Current question",
    "Notion",
    "Documents",
    "Document",
    "Pages",
    "Page",
  ]);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i].trim();
    if (!candidate) continue;
    if (blacklist.has(candidate)) continue;
    return candidate;
  }

  return null;
}

function buildHighRecallPeopleQueries(rawQuery: string, primaryQuestion: string) {
  const maxQueries = readPositiveInt("AWS_RETRIEVAL_HIGH_RECALL_MAX_QUERIES", DEFAULT_HIGH_RECALL_MAX_QUERIES);

  const trimmedQuery = rawQuery.trim();
  const trimmedQuestion = primaryQuestion.trim();
  const nameFromKeywords =
    extractPersonNameForPeopleQuery(trimmedQuestion) ||
    extractPersonNameForPeopleQuery(trimmedQuery);
  const pronounFollowUp = /\b(him|her|them|that person|this person)\b/i.test(trimmedQuestion);
  const fallbackName = pronounFollowUp ? extractLastMentionedPersonName(trimmedQuery) : null;
  const name = nameFromKeywords || fallbackName;

  const queries: string[] = [];
  const push = (value: string) => {
    const v = value.trim();
    if (!v) return;
    if (!queries.includes(v)) queries.push(v);
  };

  push(trimmedQuestion || trimmedQuery);

  if (name) {
    push(`Owner: ${name}`);
    push(`Created by: ${name}`);
    push(`Last edited by: ${name}`);
    push(`Assignees: ${name}`);
    push(`Assigned to: ${name}`);
    push(name);
  }

  // Include the full contextual query only if it differs meaningfully from the direct question.
  if (trimmedQuery && trimmedQuery !== trimmedQuestion) {
    push(trimmedQuery);
  }

  return queries.slice(0, maxQueries);
}

function buildRetrievalQueries(query: string) {
  const trimmed = query.trim();
  const queries = [trimmed];

  if (/\b(all|deep|detail|explain|how|why|who|role|status|timeline|decision|project|product|total|count|number|list|compare)\b/i.test(trimmed)) {
    queries.push(
      `${trimmed}\nInclude related people, roles, decisions, status updates, timelines, meeting notes, and linked project pages.`,
    );
    queries.push(
      `${trimmed}\nFind documents that mention the main topic or project name, then gather the relevant surrounding context.`,
    );
  }

  return [...new Set(queries)].slice(0, 3);
}

function collapseToUniqueSources(chunks: RetrievedChunk[]) {
  const bestBySource = new Map<string, RetrievedChunk>();
  const withoutSource: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    if (!chunk.source) {
      withoutSource.push(chunk);
      continue;
    }

    const prev = bestBySource.get(chunk.source);
    if (!prev || chunk.score > prev.score) {
      bestBySource.set(chunk.source, chunk);
    }
  }

  return [...bestBySource.values(), ...withoutSource].sort((a, b) => b.score - a.score);
}

function mergeChunks(chunks: RetrievedChunk[]) {
  const seen = new Set<string>();

  return chunks
    .filter((chunk) => {
      const dedupeKey = `${chunk.source || ""}:${chunk.text.slice(0, 500)}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

function formatContext(chunks: RetrievedChunk[]) {
  const maxChars = readPositiveInt("AWS_RETRIEVAL_MAX_CONTEXT_CHARS", DEFAULT_MAX_CONTEXT_CHARS);
  let totalChars = 0;
  const contextParts: string[] = [];

  for (const chunk of chunks) {
    const sourceLine = chunk.source ? `Source: ${chunk.source}\n` : "";
    const formatted = `${sourceLine}Score: ${chunk.score.toFixed(4)}\n\n${chunk.text}`;
    if (contextParts.length > 0 && totalChars + formatted.length > maxChars) break;

    contextParts.push(formatted);
    totalChars += formatted.length;
  }

  return contextParts.join("\n\n---\n\n");
}

function firstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractNotionMetadataSummary(text: string) {
  const title =
    firstMatch(text, /^DOCUMENT_TITLE:\s*(.+)$/m) ||
    firstMatch(text, /^\[DOCUMENT:\s*(.+?)\]\s*$/m) ||
    firstMatch(text, /^#\s+(.+)$/m);

  const url = firstMatch(text, /^DOCUMENT_URL:\s*(.+)$/m);
  const createdBy = firstMatch(text, /^Created by:\s*(.+)$/m);
  const createdOn = firstMatch(text, /^Created on:\s*(.+)$/m);
  const lastEditedBy = firstMatch(text, /^Last edited by:\s*(.+)$/m);
  const lastEdited = firstMatch(text, /^Last edited:\s*(.+)$/m);

  // These come from the Notion page properties section.
  const owner = firstMatch(text, /^Owner:\s*(.+)$/m);
  const assignees = firstMatch(text, /^Assignees?:\s*(.+)$/m);
  const assignedTo = firstMatch(text, /^Assigned to:\s*(.+)$/m);
  const status = firstMatch(text, /^Status:\s*(.+)$/m);
  const type = firstMatch(text, /^Type:\s*(.+)$/m);

  const lines: string[] = [];
  if (title) lines.push(`Title: ${title}`);
  if (url) lines.push(`URL: ${url}`);
  if (createdBy) lines.push(`Created by: ${createdBy}`);
  if (createdOn) lines.push(`Created on: ${createdOn}`);
  if (lastEditedBy) lines.push(`Last edited by: ${lastEditedBy}`);
  if (lastEdited) lines.push(`Last edited: ${lastEdited}`);
  if (owner) lines.push(`Owner: ${owner}`);
  if (assignees) lines.push(`Assignees: ${assignees}`);
  if (assignedTo) lines.push(`Assigned to: ${assignedTo}`);
  if (status) lines.push(`Status: ${status}`);
  if (type) lines.push(`Type: ${type}`);

  return lines.length ? lines.join("\n") : null;
}

function formatContextHighRecall(chunks: RetrievedChunk[]) {
  const maxChars = readPositiveInt(
    "AWS_RETRIEVAL_HIGH_RECALL_MAX_CONTEXT_CHARS",
    readPositiveInt("AWS_RETRIEVAL_MAX_CONTEXT_CHARS", DEFAULT_MAX_CONTEXT_CHARS),
  );
  const maxChunkChars = readPositiveInt(
    "AWS_RETRIEVAL_HIGH_RECALL_MAX_CHUNK_CHARS",
    DEFAULT_HIGH_RECALL_MAX_CHUNK_CHARS,
  );

  let totalChars = 0;
  const contextParts: string[] = [];

  for (const chunk of chunks) {
    const sourceLine = chunk.source ? `Source: ${chunk.source}\n` : "";
    const summary = extractNotionMetadataSummary(chunk.text);
    const trimmedText = chunk.text.length > maxChunkChars ? `${chunk.text.slice(0, maxChunkChars)}…` : chunk.text;
    const body = summary || trimmedText;
    const formatted = `${sourceLine}Score: ${chunk.score.toFixed(4)}\n\n${body}`;

    if (contextParts.length > 0 && totalChars + formatted.length > maxChars) break;
    contextParts.push(formatted);
    totalChars += formatted.length;
  }

  return contextParts.join("\n\n---\n\n");
}

export async function retrieveNotionContext(query: string) {
  const result = await retrieveNotionContextWithMetadata(query);
  return result.context;
}

export async function retrieveNotionContextWithMetadata(query: string): Promise<RetrievalContext> {
  const knowledgeBaseId = process.env.AWS_KNOWLEDGE_BASE_ID;
  if (!knowledgeBaseId) {
    throw new Error("AWS_KNOWLEDGE_BASE_ID is missing in environment variables");
  }

  try {
    const primaryQuestion = extractCurrentQuestion(query);
    const isHighRecall = isHighRecallPeopleListingQuery(primaryQuestion);

    const numberOfResults = isHighRecall
      ? readPositiveInt(
          "AWS_RETRIEVAL_HIGH_RECALL_RESULTS_PER_QUERY",
          DEFAULT_HIGH_RECALL_RESULTS_PER_QUERY,
        )
      : readPositiveInt(
          "AWS_RETRIEVAL_RESULTS_PER_QUERY",
          DEFAULT_RESULTS_PER_QUERY,
        );

    const retrievalQueries = isHighRecall
      ? buildHighRecallPeopleQueries(query, primaryQuestion)
      : buildRetrievalQueries(query);

    const responses = await Promise.all(
      retrievalQueries.map((retrievalQuery) => {
        const command = new RetrieveCommand({
          knowledgeBaseId,
          retrievalQuery: {
            text: retrievalQuery,
          },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults,
            },
          },
        });

        return client.send(command);
      }),
    );

    const mergedChunks = mergeChunks(
      responses.flatMap((response) =>
        (response.retrievalResults || [])
          .map((result) => ({
            text: result.content?.text || "",
            score: result.score || 0,
            source: result.location?.s3Location?.uri,
          }))
          .filter((chunk) => chunk.text),
      ),
    );

    const chunks = isHighRecall ? collapseToUniqueSources(mergedChunks) : mergedChunks;

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `Bedrock returned ${chunks.length} chunks (${new Set(chunks.map((chunk) => chunk.source).filter(Boolean)).size} sources) from ${retrievalQueries.length} queries [mode=${
          isHighRecall ? "high-recall" : "standard"
        }]`,
      );
    }

    return {
      context: isHighRecall ? formatContextHighRecall(chunks) : formatContext(chunks),
      chunkCount: chunks.length,
      retrievalQueryCount: retrievalQueries.length,
      sourceCount: new Set(chunks.map((chunk) => chunk.source).filter(Boolean)).size,
      mode: isHighRecall ? "high-recall" : "standard",
    };
  } catch (error) {
    console.error("AWS Retrieval Error:", error);
    throw error;
  }
}

const agentClient = new BedrockAgentClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export async function syncBedrockKnowledgeBase() {
  const knowledgeBaseId = process.env.AWS_KNOWLEDGE_BASE_ID;
  const dataSourceId = process.env.AWS_DATA_SOURCE_ID;

  if (!knowledgeBaseId || !dataSourceId) {
    throw new Error("AWS_KNOWLEDGE_BASE_ID or AWS_DATA_SOURCE_ID is missing in environment variables");
  }

  try {
    const command = new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
    });

    const response = await agentClient.send(command);
    return response.ingestionJob;
  } catch (error) {
    console.error("AWS Ingestion Error:", error);
    throw error;
  }
}
