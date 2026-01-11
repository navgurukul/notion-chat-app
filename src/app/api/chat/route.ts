import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getDatabaseContent } from "@/lib/notion";
import { getChatResponse } from "@/lib/gemini";

export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession();
        if (!session) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { message } = await req.json();
        if (!message) {
            return NextResponse.json({ error: "Message is required" }, { status: 400 });
        }

        const databaseId = process.env.NOTION_DATABASE_ID!;
        const notionContext = await getDatabaseContent(databaseId);

        const aiResponse = await getChatResponse(message, notionContext);

        return NextResponse.json({ response: aiResponse });
    } catch (error) {
        console.error("Chat API Error:", error);
        return NextResponse.json({ error: "Failed to get response" }, { status: 500 });
    }
}
