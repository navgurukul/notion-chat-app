import { getChatStream } from "@/lib/ai/openai";
import type { ChatHistoryItem } from "@/lib/ai/openai";
import { OPENAI_QUOTA_USER_MESSAGE, isOpenAIQuotaError } from "@/lib/ai/provider-errors";
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

const BASE_DIRECTIVE = `
## Conversation style
You are a helpful workplace assistant for NavGurukul.
Talk like a knowledgeable colleague, not a search engine.

Rules:
- Be warm and direct. If you found the answer, say it clearly without unnecessary caveats.
- If the user asks a follow-up (e.g. "tell me more", "what about X"), build on what was discussed before. Keep the response concise, conversational, and direct, avoiding repeating the same bullets or structure if already covered.
- Never say "I couldn't find information" if you have partial information — share what you found and note what's missing.
- Give complete answers. Don't truncate.
- If multiple people share a name, explicitly disambiguate based on context.
- Define workplace acronyms (like FTI -> Future-Tech Intern/Internship, FTE -> Full Time Employee/Employment) when they are first introduced in the conversation.
- Always conclude your message with a friendly, conversational next step or follow-up question (e.g. asking if they want the direct link to the Notion page, or if they have questions about a specific detail).
- Keep responses concise and avoid repeating identical information in slightly different words.

`.trimStart();

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

const SQL_SYNTHESIS_DIRECTIVE = `
## Synthesis Instructions
The user is asking to summarize, analyze, or infer a role, job, or status based on a list of tasks/pages from Notion.
Rules:
- Read the list of Notion tasks/pages provided in the context.
- Analyze the tasks to understand the person's responsibilities (e.g., frontend development, backend APIs, design, QA, project management, etc.).
- Synthesize a professional, clear explanation of their role and major areas of contribution.
- Reference specific tasks/projects from the list as evidence for your analysis.
- Do not just output the raw list of tasks; explain the themes and what they represent.

`.trimStart();

const BOOLEAN_DIRECTIVE = `
## Boolean Questions
The user is asking a yes/no or boolean question.
Rules:
- You MUST begin your answer with a direct and clear **Yes** or **No** (or **Unknown** if you cannot find enough information).
- Explain the reason for your answer concisely, referring to the context.

`.trimStart();

function isBooleanQuestion(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /^(is|does|are|was|were|has|have|had|can|should|will|do|did)\b/i.test(normalized);
}

function buildEnrichedContext(
  notionContext: string,
  queryKind: QueryKind | null,
  message: string,
): string {
  const isSynthesis = /\b(role|job|responsibilit|position|designation|title|summariz|summary|overview|analy[sz]|explain|opinion|think)\b/i.test(message) ||
    /\bwhat\s+(?:do|does|did)\s+.*\b(do|handle|manage)\b/i.test(message);

  let directive = BASE_DIRECTIVE;
  if (isSynthesis) {
    directive = `${SQL_SYNTHESIS_DIRECTIVE}${directive}`;
  } else if (queryKind && STATUS_KINDS.has(queryKind)) {
    directive = `${STATUS_SYNTHESIS_DIRECTIVE}${directive}`;
  }

  if (isBooleanQuestion(message)) {
    directive = `${BOOLEAN_DIRECTIVE}${directive}`;
  }
  
  return `${directive}${notionContext}`;
}


/** Stream OpenAI tokens to the browser and save the final answer to the chat session. */
export async function streamOpenAIAnswer(
  message: string,
  notionContext: string,
  chatHistory: ChatHistoryItem[],
  sessionId: string | null,
  queryKind: QueryKind | null = null,
  signal?: AbortSignal,
  telemetryMetadata?: {
    tStart: number;
    normalization: number;
    intentClassification: number;
    sqlAnswerAttempt: number;
    queryReformulation: number;
    queryExpansion: number;
    retrieval: number;
    expandedQueryCount: number;
    contextChars: number;
    topScore: number;
    avgScore: number;
    confidenceOk: boolean;
    historyEntityUsed: boolean;
  },
  userEmotion?: string,
) {
  const enrichedContext = buildEnrichedContext(notionContext, queryKind, message);

  const tStreamStart = performance.now();
  let stream: Awaited<ReturnType<typeof getChatStream>>;
  try {
    stream = await getChatStream(message, enrichedContext, chatHistory, userEmotion, queryKind);
  } catch (error) {
    if (isOpenAIQuotaError(error)) {
      if (sessionId) {
        addChatMessage(sessionId, "bot", OPENAI_QUOTA_USER_MESSAGE)
          .catch(error => console.error("[Background DB Write Error] Failed to persist bot message:", error));
      }
      return new Response(OPENAI_QUOTA_USER_MESSAGE, {
        status: 429,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }

  const dGetChatStream = performance.now() - tStreamStart;

  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      let rawAnswer = "";
      let firstTokenTime = 0;
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) {
            break;
          }
          const text = chunk.text();
          rawAnswer += text;
          if (firstTokenTime === 0 && text.trim().length > 0) {
            firstTokenTime = performance.now();
          }
          controller.enqueue(encoder.encode(text));
        }
      } catch (error) {
        console.error("Chat stream interrupted:", error);
        const errorText = "\n\n[Error: stream interrupted]";
        rawAnswer += errorText;
        controller.enqueue(encoder.encode(errorText));
      } finally {
        const tEnd = performance.now();
        const totalDuration = tEnd - (telemetryMetadata?.tStart ?? tStreamStart);
        const ttft = firstTokenTime > 0 ? (firstTokenTime - (telemetryMetadata?.tStart ?? tStreamStart)) : 0;

        if (telemetryMetadata) {
          console.log(
            "[telemetry]",
            JSON.stringify({
              kind: queryKind,
              expandedQueryCount: telemetryMetadata.expandedQueryCount,
              contextChars: telemetryMetadata.contextChars,
              topScore: telemetryMetadata.topScore,
              avgScore: telemetryMetadata.avgScore,
              confidenceOk: telemetryMetadata.confidenceOk,
              historyEntityUsed: telemetryMetadata.historyEntityUsed,
              durations: {
                normalization: telemetryMetadata.normalization,
                intentClassification: telemetryMetadata.intentClassification,
                sqlAnswerAttempt: telemetryMetadata.sqlAnswerAttempt,
                queryReformulation: telemetryMetadata.queryReformulation,
                queryExpansion: telemetryMetadata.queryExpansion,
                retrieval: telemetryMetadata.retrieval,
                getChatStream: Math.round(dGetChatStream),
                ttft: Math.round(ttft),
                total: Math.round(totalDuration),
              },
              ts: Date.now(),
            }),
          );
        } else {
          console.log(
            "[telemetry]",
            JSON.stringify({
              kind: queryKind,
              durations: {
                getChatStream: Math.round(dGetChatStream),
                total: Math.round(totalDuration),
              },
              ts: Date.now(),
            }),
          );
        }

        const answerForStorage = extractFinalAnswer(rawAnswer);
        if (sessionId && answerForStorage && !signal?.aborted) {
          addChatMessage(sessionId, "bot", answerForStorage, userEmotion)
            .catch(error => console.error("[Background DB Write Error] Failed to persist bot message:", error));
        }
        controller.close();
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...(userEmotion ? { "X-User-Emotion": userEmotion } : {}),
    },
  });
}