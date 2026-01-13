import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function getChatResponse(prompt: string, context: string) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        apiVersion: "v1",
      },
    });

    const systemPrompt = `
      You are an AI assistant that answers questions based on a Notion database. 
      Below is the content extracted from the database:
      
      ---
      ${context}
      ---
      
      Answer the user's question accurately using only the provided context. If the answer is not in the context, say you don't know based on the Notion data.
    `;

    const result = await model.generateContent([systemPrompt, prompt]);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini Error:", error);
    throw error;
  }
}

export async function getChatStream(prompt: string, context: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const systemPrompt = `
      You are an AI assistant that answers questions based on a Notion database. 
      Below is the content extracted from the database:
      
      ---
      ${context}
      ---
      
      Answer the user's question accurately using only the provided context. If the answer is not in the context, say you don't know based on the Notion data.
    `;

    const result = await model.generateContentStream([systemPrompt, prompt]);
    return result.stream;
  } catch (error) {
    console.error("Gemini Stream Error:", error);
    throw error;
  }
}
