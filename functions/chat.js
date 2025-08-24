// /functions/chat.js
// Cloudflare Pages Function: Proxies to OpenAI Responses API with File Search (Vector Store).
// Env vars required in Cloudflare Pages: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID
// Optional: SYSTEM_PROMPT, MODEL_ID

const MODEL_FALLBACK = "gpt-4.1-mini"; // change to your preferred low-cost model
const ALLOWED_ORIGINS = ["*"]; // tighten for production (e.g., ["https://yourdomain.com"])

function okCORS(body, origin) {
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
  const userMessage = (body && body.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return new Response("Missing 'message'", { status: 400 });

  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) return new Response("Server not configured", { status: 500 });

  const systemPrompt = env.SYSTEM_PROMPT || [
    "You are a domain‑specific assistant. Answer **only** using the provided knowledge base (File Search).",
    "If the answer is not in the documents, say \"I don't know based on the provided documents.\"",
    "When possible, include a short bullet list of citations as filenames under a 'Sources' section at the end."
  ].join(" ");

  const model = env.MODEL_ID || MODEL_FALLBACK;

  // Compose request to OpenAI Responses API with File Search tool and our Vector Store.
  const payload = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    stream: true,
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return new Response(`Upstream error: ${resp.status} ${text}`, { status: 502 });
  }

  // Stream proxy with light transformation: forward tokens and try to surface "sources" if the model emits them as JSON meta
  const readable = new ReadableStream({
    async start(controller) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n");
          for (let i = 0; i < chunks.length - 1; i++) {
            const line = chunks[i].trimStart();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              // Pass the model's incremental text
              const out = { output_text: evt.output_text || "" };
              // Heuristic: scrape "sources:" tail if the model prints them in Markdown and expose as array
              if (evt.output_text && /(?<=Sources:).*/i.test(evt.output_text)) {
                // noop; front-end already renders inline tail
              }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(out)}\n\n`));
            } catch {
              // If not JSON, just pass through unchanged
              controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
            }
          }
          buffer = chunks[chunks.length - 1];
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    }
  });

  return okCORS(readable, origin);
};
