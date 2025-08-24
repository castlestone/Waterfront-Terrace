// /functions/chat2.js
// Non-streaming JSON endpoint that uses OpenAI Responses API + File Search.
// Env vars (Cloudflare Pages → Settings → Variables and Secrets):
//   OPENAI_API_KEY (Secret)            required
//   OPENAI_VECTOR_STORE_ID             required (vs_...)
//   SYSTEM_PROMPT                      optional
//   MODEL_ID                           optional (default: gpt-4.1-mini)

const MODEL_FALLBACK = "gpt-4.1-mini";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function extractAnswer(data) {
  // Prefer top-level output_text when available
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  // Fallback: concatenate text segments from the message object
  try {
    const msg = (data?.output || []).find((o) => o.type === "message");
    if (msg?.content?.length) {
      return msg.content.map((c) => c.text || "").join("");
    }
  } catch {}
  return "";
}

function extractSourcesFromAnswer(answer) {
  // Parse a trailing "Sources: file1, file2" line (as instructed in your system prompt)
  const m = /(?:^|\n)\s*Sources:\s*(.+)\s*$/i.exec(answer || "");
  if (!m) return [];
  return m[1]
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const onRequest = async ({ request, env }) => {
  const origin = request.headers.get("Origin");

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return json(405, { error: "Method Not Allowed" }, origin);
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Bad JSON" }, origin);
  }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return json(400, { error: "Missing 'message'" }, origin);

  // Env vars
  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) {
    return json(500, { error: "Missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID" }, origin);
  }

  const model = env.MODEL_ID || MODEL_FALLBACK;
  const systemPrompt =
    env.SYSTEM_PROMPT ||
    "Answer only using the provided documents. If not present, say: \"I don't know based on the provided documents.\"";

  // ✅ Responses API: put vector store on the file_search tool (no attachments / no tool_resources)
  const payload = {
    model,
    instructions: systemPrompt,
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
      },
    ],
    input: userMessage,
    stream: false,
  };

  // Call OpenAI
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Pass through non-OK with upstream text to help debugging
  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // Success → normalize shape
  const data = await upstream.json();
  const answer = extractAnswer(data);
  const sources = extractSourcesFromAnswer(answer);

  return json(200, { answer, sources }, origin);
};
