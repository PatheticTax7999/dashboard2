import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Google GenAI client
  const apiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // API router for Coach
  app.post("/api/coach", async (req, res) => {
    try {
      const { messages, systemPrompt } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Invalid messages structure" });
      }

      // Map roles to user/model compatible with Gemini
      const contents = messages.map((m: any) => {
        const rawRole = (m.role || '').toLowerCase();
        // user stays user, ai/model/assistant maps to model
        const role = rawRole === 'user' ? 'user' : 'model';
        const text = m.content || m.text || m.message || "";
        return {
          role,
          parts: [{ text }]
        };
      });

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents,
        config: {
          systemInstruction: systemPrompt || "You are a professional fitness coach.",
        }
      });

      res.json({ reply: response.text || "I'm sorry, I couldn't generate a response." });
    } catch (err: any) {
      console.error("Coach API Error:", err);
      res.status(500).json({ error: err.message || "Internal Server Error" });
    }
  });

  // Hot Module Replacement/development or production mode serving
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
