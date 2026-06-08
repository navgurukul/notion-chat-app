import { getChatStream } from "@/lib/ai/gemini";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { GEMINI_QUOTA_USER_MESSAGE, isGeminiQuotaError } from "@/lib/ai/provider-errors";
import { addChatMessage } from "@/lib/chat/store";
import { extractFinalAnswer } from "@/lib/chat/stream-tags";
import type { QueryKind } from "@/lib/query/types";

const STATUS_KINDS = new Set<QueryKind>([
  "status_of",
  "blocker_list",
  "project_eta",
  "project_summary",
  "risks_for",
]);

const STATUS_SYNTHESIS_DIRECTIVE = `
## Answering instructions
The user is asking about the status or progress of a project. The context below may come from multiple Notion pages about the same project.

Rules:
- Synthesize across ALL retrieved pages — do not treat any single page as the only source of truth
- Identify the most recently updated page and anchor your answer to it
- If no pages have been updated recently (e.g. last edit was months ago), say so explicitly: "As of [date], the last recorded activity was…"
- Call out any blockers, risks, or unresolved items you find across pages
- If pages conflict, surface the discrepancy rather than picking one silently
- Never say "not found" or "no information" if related pages exist — summarize what IS there

`.trimStart();

function buildEnrichedContext(
  notionContext: string,
  queryKind: QueryKind | null,
): string {
  if (!queryKind || !STATUS_KINDS.has(queryKind)) return notionContext;
  return `${STATUS_SYNTHESIS_DIRECTIVE}${notionContext}`;
}

/** Stream Gemini tokens to the browser and save the final answer to the chat session. */
export async function streamGeminiAnswer(
  message: string,
  notionContext: string,
  chatHistory: ChatHistoryItem[],
  sessionId: string | null,
  queryKind: QueryKind | null = null,
  signal?: AbortSignal,
) {
  const enrichedContext = buildEnrichedContext(notionContext, queryKind);

  let stream: Awaited<ReturnType<typeof getChatStream>>;
  try {
    stream = await getChatStream(message, enrichedContext, chatHistory);
  } catch (error) {
    if (isGeminiQuotaError(error)) {
      if (sessionId) await addChatMessage(sessionId, "bot", GEMINI_QUOTA_USER_MESSAGE);
      return new Response(GEMINI_QUOTA_USER_MESSAGE, {
        status: 429,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }

  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      let rawAnswer = "";
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) {
            break;
          }
          const text = chunk.text();
          rawAnswer += text;
          controller.enqueue(encoder.encode(text));
        }
      } catch (error) {
        console.error("Chat stream interrupted:", error);
        const errorText = "\n\n[Error: stream interrupted]";
        rawAnswer += errorText;
        controller.enqueue(encoder.encode(errorText));
      } finally {
        const answerForStorage = extractFinalAnswer(rawAnswer);
        if (sessionId && answerForStorage) {
          try {
            await addChatMessage(sessionId, "bot", answerForStorage);
          } catch (error) {
            console.error("Failed to persist bot message:", error);
          }
        }
        controller.close();
      }
    },
  });

  return new Response(readableStream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}