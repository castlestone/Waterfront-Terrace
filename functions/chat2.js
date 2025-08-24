// /functions/chat2.js
const MODEL_FALLBACK = "gpt-4.1-mini";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const onRequest = async ({ request, env }) => {
  // Allow CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Bad JSON" }); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return json(400, { error: "Missing 'message'" });

  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) return json(500, { error: "Missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID" });

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "Answer only using the provided documents. If not present, say you don't know.";

  // ✅ Responses API: file_search tool with vector_store_ids; no attachments/tool_resources
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    input: userMessage,
    stream: false,
  };

  console.log("Calling Responses API (no attachments), VS:", vectorStoreId);

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();
  // Pass through status & body so you can see exact upstream errors if any
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
};
