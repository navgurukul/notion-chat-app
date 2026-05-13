import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getChatStream } from "@/lib/gemini";
import { authOptions } from "@/lib/auth";
import { buildContextualSearchQuery, sanitizeChatHistory } from "@/lib/chat";
import { parseQuery } from "@/lib/query-router";
import { verifyQueryWithAI } from "@/lib/query-verifier";
import { handleMetadataQuery } from "@/lib/metadata-search";
import { semanticSearch } from "@/lib/vector-search";
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
  const answerMatch = rawText.match(/\[\[ANSWER\]\]([\s\S]*?)(?:\[\[\/ANSWER\]\]|$)/);
  const answer = answerMatch?.[1] ?? rawText;
  return answer
    .replace(/\[\[(?:\/)?(?:THINKING|ANSWER)\]\]/g, "")
    .trim();
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
    const parsedByRules = parseQuery(trimmedMessage);
    const parsed = await verifyQueryWithAI(trimmedMessage, parsedByRules);

    if (process.env.NODE_ENV !== "production") {
      console.log("[chat] parsed_query=", { rules: parsedByRules, final: parsed });
    }

    if (parsed.kind !== "semantic") {
      const directAnswer = await handleMetadataQuery(parsed);
      if (directAnswer) {
        if (ownedSessionId) {
          await addChatMessage(ownedSessionId, "bot", directAnswer);
        }
        return new Response(directAnswer, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    const notionContext = await semanticSearch(trimmedMessage);
    const searchQuery = buildContextualSearchQuery(trimmedMessage, chatHistory);

    if (process.env.NODE_ENV !== "production") {
      console.log(`[chat] mode=semantic context_chars=${notionContext.length}`);
    }

    const stream = await getChatStream(searchQuery, notionContext, chatHistory);

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
