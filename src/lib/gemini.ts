import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

//  Your existing working function - UNCHANGED
export async function getChatResponse(prompt: string, context: string) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro-latest",
    });

    const systemPrompt = `
      You are an AI assistant that answers questions based on NavGurukul's Notion documentation.
      Below is the content extracted from the database:

      ---
      ${context}
      ---

      // Answer the user's question accurately using only the provided context. If the answer is not in the context, say you don't know based on the Notion data.
    `;

    // const systemPrompt = `
    //   You are an AI assistant that answers questions based on NavGurukul's Notion documentation. 
    //   Below is the content extracted from the database:

    //   ---
    //   ${context}
    //   ---

    //   INSTRUCTIONS:
    //   - Answer using ONLY the provided context.
    //   - Include ALL relevant points related to the question.
    //   - Do NOT omit any important idea mentioned in the document.
    //   - Do NOT add assumptions or external knowledge.
    //   - If the answer is not in the context, say you don't know based on the Notion data.
    //   `;

    //  log the exact context being sent to the model
    console.log("===== CONTEXT SENT TO MODEL START =====");
    console.log(context);
    console.log("===== CONTEXT SENT TO MODEL END =====");

    const result = await model.generateContent([systemPrompt, prompt]);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini Error:", error);
    throw error;
  }
}

//  Your existing working function - UNCHANGED
export async function getChatStream(prompt: string, context: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const systemPrompt = `
      You are an AI assistant that answers questions based on NavGurukul's Notion documentation. 
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
