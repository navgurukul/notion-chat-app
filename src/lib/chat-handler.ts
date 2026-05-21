import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { getChatStream } from "@/lib/gemini";
import {
  extractReferencedTitle,
  isNotionLinkRequest,
  resolveSemanticSearchQuery,
  sanitizeChatHistory,
} from "@/lib/chat";
import { resolveQuery } from "@/lib/query/resolve-query";
import { handleMetadataQuery, lookupPageLinkByTitle } from "@/lib/metadata-search";
import { buildNotionContextForChat } from "@/lib/notion-context";
import { addChatMessage, ensureSessionBelongsToUser, getOrCreateUser } from "@/lib/chat-store";
import { extractFinalAnswer } from "@/lib/stream-tags";
import type { ParsedQuery } from "@/lib/query/types";

const MAX_MESSAGE_LENGTH = 2000;

const STRUCTURED_QUERY_KINDS = new Set([
  "page_about",
  "project_summary",
  "compare_pages",
  "risks_for",
  "onboarding_tasks",
  "owner_of",
  "created_by_of",
  "assigned_to_of",
  "type_of",
  "status_of",
]);

type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
  sessionId?: unknown;
};

async function persistBotReply(sessionId: string | null, text: string) {
  if (sessionId) await addChatMessage(sessionId, "bot", text);
}

async function jsonAnswer(sessionId: string | null, answer: string) {
  await persistBotReply(sessionId, answer);
  return NextResponse.json({ answer });
}

export async function handleChatPost(session: Session, body: ChatRequestBody) {
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const trimmedMessage = body.message.trim().slice(0, MAX_MESSAGE_LENGTH);
  let ownedSessionId: string | null = null;

  if (typeof body.sessionId === "string" && body.sessionId.trim()) {
    const user = await getOrCreateUser(session);
    const ownsSession = await ensureSessionBelongsToUser(body.sessionId, user.id);
    if (!ownsSession) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    ownedSessionId = body.sessionId;
    await addChatMessage(ownedSessionId, "user", trimmedMessage);
  }

  const chatHistory = sanitizeChatHistory(body.history);

  if (isNotionLinkRequest(trimmedMessage)) {
    const linkTitle = extractReferencedTitle(trimmedMessage, chatHistory);
    if (linkTitle) {
      const linkAnswer = await lookupPageLinkByTitle(linkTitle);
      if (linkAnswer) return jsonAnswer(ownedSessionId, linkAnswer);
      return jsonAnswer(
        ownedSessionId,
        `I couldn't find a synced Notion page titled **${linkTitle}**. Use **Sync changes**, or ask with the exact page title from Notion.`,
      );
    }
    if (/\b(it|this|that)\b/i.test(trimmedMessage)) {
      const unresolved =
        chatHistory.length > 0
          ? "I couldn't resolve which page you mean from chat history. Ask again with the full page title, e.g. link for **Structuring the Product Team**."
          : "I couldn't resolve which page you mean — include the page title, or ask about a page first so chat history has context.";
      return jsonAnswer(ownedSessionId, unresolved);
    }
  }

  const parsed = await resolveQuery(trimmedMessage);

  if (process.env.NODE_ENV !== "production") {
    console.log("[chat] parsed_query=", {
      kind: parsed.kind,
      confidence: parsed.confidence,
      source: parsed.source,
      personName: parsed.personName,
      docTitle: parsed.docTitle,
    });
  }

  const directAnswer = await tryStructuredAnswer(parsed, ownedSessionId);
  if (directAnswer) return directAnswer;

  if (isNotionLinkRequest(trimmedMessage)) {
    return jsonAnswer(
      ownedSessionId,
      "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.",
    );
  }

  let searchQuery = resolveSemanticSearchQuery(trimmedMessage, chatHistory);
  if (parsed.kind === "semantic" && parsed.docTitle?.trim()) {
    searchQuery = `${parsed.docTitle.trim()} ${searchQuery}`;
  }

  const notionContext = await buildNotionContextForChat(searchQuery);
  if (!notionContext.trim()) {
    return jsonAnswer(
      ownedSessionId,
      "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
    );
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[chat] mode=semantic context_chars=${notionContext.length}`);
  }

  return streamGeminiAnswer(trimmedMessage, notionContext, chatHistory, ownedSessionId);
}

async function tryStructuredAnswer(parsed: ParsedQuery, ownedSessionId: string | null) {
  if (parsed.kind === "semantic") return null;

  const directAnswer = await handleMetadataQuery(parsed);
  if (directAnswer) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[chat] mode=${parsed.kind} search=sql_direct answer_chars=${directAnswer.length}`,
      );
    }
    return jsonAnswer(ownedSessionId, directAnswer);
  }

  if (STRUCTURED_QUERY_KINDS.has(parsed.kind) && parsed.docTitle?.trim()) {
    return jsonAnswer(
      ownedSessionId,
      `I couldn't find **${parsed.docTitle.trim()}** in the synced Notion database. Use **Sync changes** in the sidebar, then try again.`,
    );
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[chat] mode=${parsed.kind} search=sql_empty fallback=semantic`);
  }

  return null;
}

async function streamGeminiAnswer(
  message: string,
  notionContext: string,
  chatHistory: ReturnType<typeof sanitizeChatHistory>,
  ownedSessionId: string | null,
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
        if (ownedSessionId && answerForStorage) {
          try {
            await addChatMessage(ownedSessionId, "bot", answerForStorage);
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
