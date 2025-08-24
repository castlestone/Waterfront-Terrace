// scripts/upload_vector_store.mjs
// Usage:
//   export OPENAI_API_KEY=sk-...
//   node upload_vector_store.mjs
// Puts all files under ../docs into a new Vector Store (or updates an existing one).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DOCS_DIR = path.resolve(process.cwd(), "../docs");

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

async function ensureVectorStore(name = "ask-my-docs-store") {
  const vs = await openai.vectorStores.create({ name });
  return vs;
}

async function uploadDirToVectorStore(vectorStoreId, dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (!entries.length) {
    console.log(`No files found in ${dir} — add PDFs/MD/TXT and rerun.`);
    return;
  }
  console.log(`Uploading ${entries.length} file(s) to vector store ${vectorStoreId} ...`);
  const uploads = [];
  for (const fname of entries) {
    const full = path.join(dir, fname);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    uploads.push(openai.files.create({ file: fs.createReadStream(full), purpose: "assistants" }));
  }
  const files = await Promise.all(uploads);
  const fileIds = files.map(f => f.id);
  await openai.vectorStores.files.batchCreate(vectorStoreId, { file_ids: fileIds });
  console.log("Uploaded files:", files.map(f => `${f.filename} (${f.id})`).join(", "));
}

(async () => {
  try {
    const store = await ensureVectorStore();
    await uploadDirToVectorStore(store.id, DOCS_DIR);
    console.log("\nVECTOR_STORE_ID:", store.id);
    console.log("Set this as OPENAI_VECTOR_STORE_ID in Cloudflare Pages → Settings → Environment Variables.");
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    process.exit(1);
  }
})();
