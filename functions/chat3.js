// /functions/chat3.js — Non-streaming; returns { answer, sources }
const MODEL_FALLBACK = "gpt-4.1-mini";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function send(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
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

export const onRequest = async ({ request, env }) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (request.method !== "POST")   return send(405, { error: "Method Not Allowed" }, origin);

  let body;
  try { body = await request.json(); } catch { return send(400, { error: "Bad JSON" }, origin); }
  const userMessage = (body?.message || "").toString().slice(0, 4000).trim();
  if (!userMessage) return send(400, { error: "Missing 'message'" }, origin);

  const apiKey = env.OPENAI_API_KEY;
  const vectorStoreId = env.OPENAI_VECTOR_STORE_ID;
  if (!apiKey || !vectorStoreId) return send(500, { error: "Missing OPENAI_API_KEY or OPENAI_VECTOR_STORE_ID" }, origin);

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

  // If OpenAI returns an error, bubble it up as-is for visibility
  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, { status: upstream.status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
  }

  const data   = await upstream.json();
  const answer = extractAnswer(data);
  const sources = extractSourcesFromAnswer(answer);

  return send(200, { answer, sources }, origin);
};
