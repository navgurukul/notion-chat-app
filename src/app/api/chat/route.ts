import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getChatStream } from "@/lib/gemini";
import { authOptions } from "@/lib/auth";
import { buildContextualSearchQuery, sanitizeChatHistory } from "@/lib/chat";
import { parseQuery } from "@/lib/query-router";
import { handleMetadataQuery } from "@/lib/metadata-search";
import { semanticSearch } from "@/lib/vector-search";

const MAX_MESSAGE_LENGTH = 2000;

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message, history } = await req.json();
    if (typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 },
      );
    }

    const trimmedMessage = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    const chatHistory = sanitizeChatHistory(history);
    const parsed = parseQuery(trimmedMessage);

    if (parsed.kind !== "semantic") {
      const directAnswer = await handleMetadataQuery(parsed);
      if (directAnswer) {
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
        for await (const chunk of stream) {
          const text = chunk.text();
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
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
