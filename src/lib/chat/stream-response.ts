import { getChatStream } from "@/lib/ai/gemini";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { addChatMessage } from "@/lib/chat/store";
import { extractFinalAnswer } from "@/lib/chat/stream-tags";

/** Stream Gemini tokens to the browser and save the final answer to the chat session. */
export async function streamGeminiAnswer(
  message: string,
  notionContext: string,
  chatHistory: ChatHistoryItem[],
  sessionId: string | null,
) {
  const stream = await getChatStream(message, notionContext, chatHistory);
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
