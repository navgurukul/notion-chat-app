import { NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth/session";
import { STT_TRANSCRIPTION_PROMPT } from "@/lib/stt/stt-prompt";
import { checkRateLimit } from "@/lib/shared/rate-limit";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/mp4a-latm",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
]);

export async function POST(request: Request) {
  const session = await requireSession();
  if (isSessionResponse(session)) return session;
  const limit = checkRateLimit(session.user?.email ?? "anonymous");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let audio: FormDataEntryValue | null;
  try {
    audio = (await request.formData()).get("audio");
  } catch {
    return NextResponse.json({ error: "Invalid audio upload." }, { status: 400 });
  }

  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "Please record audio before transcribing." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Recording is too large. Please record a shorter message." }, { status: 413 });
  }
  if (!ALLOWED_AUDIO_TYPES.has(audio.type.toLowerCase().split(";")[0])) {
    return NextResponse.json({ error: "This browser's audio format is not supported." }, { status: 415 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Voice transcription is not configured on the server." }, { status: 503 });
  }

  const payload = new FormData();
  payload.append("file", audio, audio.name || "recording.webm");
  payload.append("model", "gpt-4o-mini-transcribe");
  payload.append("response_format", "json");
  payload.append("prompt", STT_TRANSCRIPTION_PROMPT);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: payload,
      signal: request.signal,
    });
    if (!response.ok) {
      const status = response.status === 429 ? 503 : 502;
      console.error("STT provider error:", response.status, await response.text());
      return NextResponse.json({ error: "Audio transcription failed. Please try again." }, { status });
    }

    const result = (await response.json()) as { text?: unknown };
    if (typeof result.text !== "string" || !result.text.trim()) {
      return NextResponse.json({ error: "No speech was detected. Try again or type your message." }, { status: 422 });
    }
    return NextResponse.json({ text: result.text.trim() });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("STT request failed:", error);
    return NextResponse.json({ error: "Audio transcription failed. Please try again." }, { status: 502 });
  }
}
