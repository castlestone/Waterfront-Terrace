// /functions/chat3.js — Non-streaming; returns { answer, sources } for POST
const MODEL_FALLBACK = "gpt-4.1-mini";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractAnswer(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  try {
    const msg = (data?.output || []).find(o => o.type === "message");
    if (msg?.content?.length) return msg.content.map(c => c.text || "").join("");
  } catch {}
  return "";
}

function extractSourcesFromAnswer(answer) {
  const m = /(?:^|\n)\s*Sources:\s*(.+)\s*$/i.exec(answer || "");
  if (!m) return [];
  return m[1].split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

export const onRequestPost = async ({ request, env }) => {
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
    "Answer only using the provided documents. If not present, say: \"I don't know based on the provided documents.\"";

  const payload = {
    model,
    instructions: systemPrompt,
    tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    input: userMessage,
    stream: false,
  };

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  }

  const data = await upstream.json();
  const answer = extractAnswer(data);
  const sources = extractSourcesFromAnswer(answer);
  return json(200, { answer, sources });
};

// Optional: let browsers preflight without a 405
export const onRequestOptions = async () => new Response(null, {
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
});

// For any non-POST method, return 405 (useful for quick route checks)
export const onRequestGet = async () => json(405, { error: "Method Not Allowed" });
