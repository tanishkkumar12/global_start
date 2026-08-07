import { GoogleGenAI } from "@google/genai";

export const config = {
  runtime: "edge",
};

function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim();
}

async function tryGeminiStream(contents: any, systemInstruction: any) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing");
  }
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: { "User-Agent": "aistudio-build" },
    },
  });
  const models = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ];
  let lastError: any = null;

  for (const model of models) {
    try {
      return await ai.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction, temperature: 0.7 }
      });
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini Edge] Model ${model} failed:`, err?.message || err);
    }
  }
  throw lastError || new Error("All Gemini models failed on Edge");
}

async function tryOpenRouterStream(messages: any[]) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing from environment variables");
  }
  const models = [
    "google/gemini-2.5-flash",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-8b-instruct",
    "deepseek/deepseek-r1-distill-llama-8b"
  ];

  let lastError: any = null;
  for (const model of models) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://ai.studio/build",
          "X-Title": "Restaurant Applet",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
        }),
      });

      if (response.ok && response.body) {
        return response.body;
      } else {
        const errText = await response.text();
        lastError = new Error(`OpenRouter ${model} status ${response.status}: ${errText}`);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All OpenRouter models failed");
}

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { message, history, systemInstruction } = await req.json();

    const historyMessages = (history || []).map((msg: any) => ({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content || ""
    }));

    const openRouterMessages = [
      ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
      ...historyMessages,
      { role: "user", content: message }
    ];

    let geminiStream: any = null;
    if (process.env.GEMINI_API_KEY) {
      try {
        const contents = historyMessages.map(m => ({
          role: m.role === "user" ? "user" : "model",
          parts: [{ text: m.content }]
        }));
        contents.push({ role: "user", parts: [{ text: message }] });

        geminiStream = await tryGeminiStream(contents, systemInstruction);
      } catch (err) {
        console.warn("[Edge Handler] Gemini failed, falling back to OpenRouter:", err);
      }
    }

    if (geminiStream) {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const heartbeat = setInterval(() => {
            try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch (e) {}
          }, 10000);

          try {
            for await (const chunk of geminiStream) {
              const text = chunk.text || "";
              if (text) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (err: any) {
            console.error("Gemini stream error:", err);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
          } finally {
            clearInterval(heartbeat);
            controller.close();
          }
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Try OpenRouter
    const openRouterBody = await tryOpenRouterStream(openRouterMessages);
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const reader = openRouterBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let lineIndex;
          while ((lineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, lineIndex).trim();
            buffer = buffer.slice(lineIndex + 1);

            if (line.startsWith("data:")) {
              const dataStr = line.slice(5).trim();
              if (dataStr === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                break;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
                }
              } catch (e) {
                /* ignore partial chunk */
              }
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });

  } catch (finalErr: any) {
    console.error("All AI options failed in api/chat.ts:", finalErr);
    return new Response(
      JSON.stringify({ error: finalErr.message || "Failed to communicate with AI model" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
