import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "dummy_key",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

function getOpenRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim();
}

async function generateStreamWithRetry(contents: any, systemInstruction: any) {
  const models = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b"
  ];
  let lastError: any = null;

  for (const model of models) {
    let delay = 1000;
    const retries = 3;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[Gemini API] Trying streaming generation with ${model} (Attempt ${attempt}/${retries})`);
        return await ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
          }
        });
      } catch (error: any) {
        lastError = error;
        const errMsg = String(error?.message || error || "");
        const errStatus = error?.status || error?.code;

        const is429 = errStatus === 429 || errMsg.includes("429") || errMsg.toLowerCase().includes("quota");
        const is503 = errStatus === 503 || errMsg.includes("503") || errMsg.toLowerCase().includes("unavailable") || errMsg.toLowerCase().includes("high demand") || errMsg.toLowerCase().includes("temporary");

        if (is429) {
          const modelIndex = models.indexOf(model);
          if (modelIndex < models.length - 1) {
            console.warn(`[Gemini API] Quota limit hit on ${model}. Switching to fallback model: ${models[modelIndex + 1]}...`);
            break; // try the next model
          }
        }

        if (is503 && attempt < retries) {
          console.warn(`[Gemini API] Temporary Service Spike on ${model} (Attempt ${attempt}/${retries}). Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
        } else {
          const modelIndex = models.indexOf(model);
          if (modelIndex < models.length - 1) {
            console.warn(`[Gemini API] Failover from ${model} to fallback model ${models[modelIndex + 1]} due to: ${errMsg}`);
            break; // try the next model
          } else {
            console.error(`[Gemini API] All Gemini models exhausted. Final error on ${model}: ${errMsg}`);
            throw error;
          }
        }
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes FIRST
  app.post("/api/chat", async (req, res) => {
    const { message, history, systemInstruction } = req.body;

    let geminiError: any = null;
    let geminiSucceeded = false;

    if (process.env.GEMINI_API_KEY) {
      try {
        const contents = [];
        if (history && Array.isArray(history)) {
          for (const msg of history) {
            contents.push({
              role: msg.role === "user" ? "user" : "model",
              parts: [{ text: msg.content || "" }]
            });
          }
        }
        contents.push({
          role: "user",
          parts: [{ text: message }]
        });

        const responseStream = await generateStreamWithRetry(contents, systemInstruction);

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering

        // Send a heartbeat every 10 seconds to keep the connection alive
        const heartbeatInterval = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": heartbeat\n\n");
            if ((res as any).flush) (res as any).flush();
          }
        }, 10000);

        try {
          for await (const chunk of responseStream) {
            const content = chunk.text || "";
            
            if (content) {
              res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
              if ((res as any).flush) {
                (res as any).flush();
              }
            }
          }
          res.write("data: [DONE]\n\n");
          geminiSucceeded = true;
        } finally {
          clearInterval(heartbeatInterval);
        }
      } catch (error: any) {
        geminiError = error;
        console.error("Gemini API Error occurred, checking for OpenRouter fallback...", error);
      }
    } else {
      geminiError = new Error("GEMINI_API_KEY is missing");
    }

    if (geminiSucceeded) {
      res.end();
      return;
    }

    // Try OpenRouter fallback
    const openRouterKey = getOpenRouterApiKey();
    if (openRouterKey) {
      console.log("[OpenRouter API] Gemini failed or not configured. Falling back to OpenRouter...");
      try {
        if (!res.headersSent) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
        }

        const historyMessages = (history || []).map((msg: any) => ({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content || ""
        }));

        const openRouterModels = [
          "google/gemini-2.5-flash",
          "google/gemini-flash-1.5",
          "meta-llama/llama-3.1-8b-instruct"
        ];

        let openRouterResponse: Response | null = null;
        let lastOpenRouterError: any = null;

        for (const orModel of openRouterModels) {
          try {
            console.log(`[OpenRouter API] Trying generation with ${orModel}`);
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${openRouterKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://ai.studio/build",
                "X-Title": "Restaurant Applet",
              },
              body: JSON.stringify({
                model: orModel,
                messages: [
                  ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
                  ...historyMessages,
                  { role: "user", content: message }
                ],
                stream: true,
              }),
            });

            if (response.ok) {
              openRouterResponse = response;
              break;
            } else {
              const errText = await response.text();
              console.warn(`[OpenRouter API] Model ${orModel} returned error: ${response.status} - ${errText}`);
              lastOpenRouterError = new Error(`OpenRouter returned status ${response.status}: ${errText}`);
            }
          } catch (err) {
            console.warn(`[OpenRouter API] Failed to fetch from ${orModel}:`, err);
            lastOpenRouterError = err;
          }
        }

        if (!openRouterResponse) {
          throw lastOpenRouterError || new Error("All OpenRouter models failed");
        }

        const reader = (openRouterResponse.body as any)?.getReader();
        if (!reader) {
          throw new Error("No reader available for OpenRouter response stream");
        }

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
                break;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  res.write(`data: ${JSON.stringify({ text })}\n\n`);
                  if ((res as any).flush) (res as any).flush();
                }
              } catch (e) {
                // Ignore partial chunk parsing
              }
            }
          }
        }

        res.write("data: [DONE]\n\n");
        res.end();
        return;
      } catch (orError: any) {
        console.error("OpenRouter API Fallback Error:", orError);
      }
    }

    // Both failed
    console.error("Both Gemini and OpenRouter failed to answer");
    const errMsg = String(geminiError?.message || geminiError || "");
    let errorMessage = geminiError?.message || "Failed to fetch response from AI";
    
    const is503OrUnavailable = 
      geminiError?.status === 503 || 
      geminiError?.code === 503 || 
      errMsg.includes("503") || 
      errMsg.toLowerCase().includes("unavailable") || 
      errMsg.toLowerCase().includes("high demand") ||
      errMsg.toLowerCase().includes("temporary");

    if (is503OrUnavailable) {
      errorMessage = "The AI service is experiencing very high demand (Error 503: Service Unavailable). Please try again in a few seconds, or check that your API keys are correctly configured!";
    }

    if (!res.headersSent) {
      res.status(500).json({ error: errorMessage });
    } else {
      res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      res.end();
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
