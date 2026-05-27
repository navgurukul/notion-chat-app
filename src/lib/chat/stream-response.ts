import { getChatStream } from "@/lib/ai/gemini";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { GEMINI_QUOTA_USER_MESSAGE, isGeminiQuotaError } from "@/lib/ai/provider-errors";
import { addChatMessage } from "@/lib/chat/store";
import { extractFinalAnswer } from "@/lib/chat/stream-tags";

/** Stream OpenAI tokens to the browser and save the final answer to the chat session. */
export async function streamGeminiAnswer(
  message: string,
  notionContext: string,
  chatHistory: ChatHistoryItem[],
  sessionId: string | null,
) {
  let stream: Awaited<ReturnType<typeof getChatStream>>;
  try {
    stream = await getChatStream(message, notionContext, chatHistory);
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
