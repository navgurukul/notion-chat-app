import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { retrieveNotionContext } from "@/lib/aws";
import { getChatStream } from "@/lib/gemini";
import { authOptions } from "@/lib/auth";
import { buildContextualSearchQuery, sanitizeChatHistory } from "@/lib/chat";

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
        { status: 400 }
      );
    }

    const chatHistory = sanitizeChatHistory(history);
    const searchQuery = buildContextualSearchQuery(message.trim(), chatHistory);

    // 🚀 Use AWS Bedrock Knowledge Base for scalable RAG
    const notionContext = await retrieveNotionContext(searchQuery);

    if (process.env.NODE_ENV !== "production") {
      console.log("Retrieved context length:", notionContext?.length || 0);
    }

    const stream = await getChatStream(message.trim(), notionContext, chatHistory);

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
      { status: 500 }
    );
  }
}
