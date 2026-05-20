import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getChatStream } from "@/lib/gemini";
import { authOptions } from "@/lib/auth";
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

const MAX_MESSAGE_LENGTH = 2000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userKey: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(userKey);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

function extractAnswerForStorage(rawText: string) {
  const answerMatch = rawText.match(/\[\[ANSWER\]\]([\s\S]*?)(?:\[\[\/ANSWER\]\]|$)/i);
  let answer = answerMatch?.[1] ?? rawText;
  answer = answer.replace(/\[\[(?:\/)?(?:THINKING|ANSWER)\]\]/gi, "").trim();

  const thinkingOnly =
    /\[\[THINKING\]\][\s\S]*\[\[\/THINKING\]\]/i.test(rawText) && !answerMatch;
  if (thinkingOnly) {
    const afterThinking = rawText
      .replace(/\[\[THINKING\]\][\s\S]*?\[\[\/THINKING\]\]/i, "")
      .replace(/\[\[(?:\/)?(?:THINKING|ANSWER)\]\]/gi, "")
      .trim();
    if (afterThinking) answer = afterThinking;
  }

  const cleaned = answer
    .replace(
      /^(?:the user is asking|i will scan|i need to search)[\s\S]*?(?=\n\n|\n#|\n-|$)/i,
      "",
    )
    .trim();

  if (cleaned.length < 200) return cleaned;
  const half = Math.floor(cleaned.length / 2);
  const first = cleaned.slice(0, half).trim();
  const second = cleaned.slice(half).trim();
  if (first.length > 80 && second.startsWith(first.slice(0, Math.min(120, first.length)))) {
    return first;
  }
  return cleaned;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userKey = session.user?.email || "anonymous";
    if (!checkRateLimit(userKey)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute and try again." },
        { status: 429 },
      );
    }

    const { message, history, sessionId } = await req.json();
    if (typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 },
      );
    }

    const trimmedMessage = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    let ownedSessionId: string | null = null;
    if (typeof sessionId === "string" && sessionId.trim()) {
      const user = await getOrCreateUser(session);
      const ownsSession = await ensureSessionBelongsToUser(sessionId, user.id);
      if (!ownsSession) {
        return NextResponse.json({ error: "Chat not found" }, { status: 404 });
      }
      ownedSessionId = sessionId;
      await addChatMessage(ownedSessionId, "user", trimmedMessage);
    }

    const chatHistory = sanitizeChatHistory(history);

    if (isNotionLinkRequest(trimmedMessage)) {
      const linkTitle = extractReferencedTitle(trimmedMessage, chatHistory);
      if (linkTitle) {
        const linkAnswer = await lookupPageLinkByTitle(linkTitle);
        if (linkAnswer) {
          if (ownedSessionId) {
            await addChatMessage(ownedSessionId, "bot", linkAnswer);
          }
          return NextResponse.json({ answer: linkAnswer });
        }
        const notFound = `I couldn't find a synced Notion page titled **${linkTitle}**. Use **Sync changes**, or ask with the exact page title from Notion.`;
        if (ownedSessionId) {
          await addChatMessage(ownedSessionId, "bot", notFound);
        }
        return NextResponse.json({ answer: notFound });
      }
      if (/\b(it|this|that)\b/i.test(trimmedMessage)) {
        const unresolved =
          chatHistory.length > 0
            ? "I couldn't resolve which page you mean from chat history. Ask again with the full page title, e.g. link for **Structuring the Product Team**."
            : "I couldn't resolve which page you mean — include the page title, or ask about a page first so chat history has context.";
        if (ownedSessionId) {
          await addChatMessage(ownedSessionId, "bot", unresolved);
        }
        return NextResponse.json({ answer: unresolved });
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

    const structuredKinds = new Set([
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

    if (parsed.kind !== "semantic") {
      const directAnswer = await handleMetadataQuery(parsed);
      if (directAnswer) {
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `[chat] mode=${parsed.kind} search=sql_direct answer_chars=${directAnswer.length}`,
          );
        }
        if (ownedSessionId) {
          await addChatMessage(ownedSessionId, "bot", directAnswer);
        }
        return NextResponse.json({ answer: directAnswer });
      }
      if (structuredKinds.has(parsed.kind) && parsed.docTitle?.trim()) {
        const notSynced = `I couldn't find **${parsed.docTitle.trim()}** in the synced Notion database. Use **Sync changes** in the sidebar, then try again.`;
        if (ownedSessionId) {
          await addChatMessage(ownedSessionId, "bot", notSynced);
        }
        return NextResponse.json({ answer: notSynced });
      }
      if (process.env.NODE_ENV !== "production") {
        console.log(`[chat] mode=${parsed.kind} search=sql_empty fallback=semantic`);
      }
    }

    if (isNotionLinkRequest(trimmedMessage)) {
      const needTitle =
        "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.";
      if (ownedSessionId) {
        await addChatMessage(ownedSessionId, "bot", needTitle);
      }
      return NextResponse.json({ answer: needTitle });
    }

    let searchQuery = resolveSemanticSearchQuery(trimmedMessage, chatHistory);
    if (parsed.kind === "semantic" && parsed.docTitle?.trim()) {
      searchQuery = `${parsed.docTitle.trim()} ${searchQuery}`;
    }
    const notionContext = await buildNotionContextForChat(searchQuery);

    if (!notionContext.trim()) {
      const emptyAnswer =
        "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.";
      if (ownedSessionId) {
        await addChatMessage(ownedSessionId, "bot", emptyAnswer);
      }
      return NextResponse.json({ answer: emptyAnswer });
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(`[chat] mode=semantic context_chars=${notionContext.length}`);
    }

    const stream = await getChatStream(trimmedMessage, notionContext, chatHistory);

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
          const answerForStorage = extractAnswerForStorage(rawAnswer);
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
  } catch (error) {
    console.error("Chat API Error:", error);
    return NextResponse.json(
      { error: "Failed to get response" },
      { status: 500 },
    );
  }
}
