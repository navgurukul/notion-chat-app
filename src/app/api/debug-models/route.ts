import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}&pageSize=100`,
    );
    const data = await response.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };

    const embeddingModels = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("embedContent"))
      .map((m) => m.name);

    return NextResponse.json({ embeddingModels, total: embeddingModels.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
