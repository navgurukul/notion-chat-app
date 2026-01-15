import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { retrieveNotionContext } from "@/lib/aws";
import { getChatStream } from "@/lib/gemini";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await req.json();
    if (!message) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // 🚀 Use AWS Bedrock Knowledge Base for scalable RAG
    const notionContext = await retrieveNotionContext(message);

    console.log("🔍 Search Query:", message);
    console.log("📄 Retrieved Context Length:", notionContext?.length || 0);
    if (!notionContext) {
      console.warn("⚠️ Warning: Notion context is empty! The AI might not have enough data to answer.");
    }

    const stream = await getChatStream(message, notionContext);

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
