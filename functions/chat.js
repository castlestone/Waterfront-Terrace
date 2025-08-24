// /functions/chat.js
// Cloudflare Pages Function: Proxies to OpenAI Responses API with File Search (Vector Store).
// Env vars: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID, optional SYSTEM_PROMPT, MODEL_ID

const MODEL_FALLBACK = "gpt-4.1-mini";
const ALLOWED_ORIGINS = ["*"]; // tighten in production

function sseResponse(body, origin) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export const onRequestOptions = async ({ request }) => {
  const origin = request.headers.get("Origin") || "*";
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const onRequestPost = async ({ request, env }) => {
  const origin = request.headers.get("Origin") || "*";
  if (ALLOWED_ORIGINS[0] !== "*" && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400 });

  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) return new Response("Server not configured", { status: 500 });

  const systemPrompt = env.SYSTEM_PROMPT || [
    "You are a domain-specific assistant. Answer only using the provided knowledge base.",
    'If the answer is not in the documents, say "I don\'t know based on the provided documents."'
  ].join(" ");

  const model = env.MODEL_ID || MODEL_FALLBACK;

  // ✅ Responses API: attach the vector store on the USER message via attachments
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search" }],
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
        attachments: [
          { vector_store_id: vectorStoreId, tools: [{ type: "file_search" }] }
        ]
      }
    ],
    stream: true,
  };

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(`Upstream error: ${upstream.status} ${text}`, { status: 502 });
  }

  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trimStart();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              const out = { output_text: evt.output_text || "" };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(out)}\n\n`));
            } catch {
              controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
            }
          }
          buffer = lines[lines.length - 1];
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.error(err);
      }
    }
  });

  return sseResponse(readable, origin);
};
