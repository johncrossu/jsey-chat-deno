import { AwsClient } from "npm:aws4fetch";

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";
const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL") || "";
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || "";

const B2_KEY_ID = Deno.env.get("B2_KEY_ID") || "";
const B2_APP_KEY = Deno.env.get("B2_APP_KEY") || "";
const B2_BUCKET = Deno.env.get("B2_BUCKET") || "";
const B2_ENDPOINT = Deno.env.get("B2_ENDPOINT") || "";
const B2_REGION = Deno.env.get("B2_REGION") || "us-east-005";

const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const R2_SECRET_KEY = Deno.env.get("R2_SECRET_KEY") || "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") || "";
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";

const B2_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "content-type, x-admin-secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

async function redisCmd(...parts: string[]) {
  const url = UPSTASH_URL + "/" + parts.map(encodeURIComponent).join("/");
  const res = await fetch(url, { headers: { Authorization: "Bearer " + UPSTASH_TOKEN } });
  const data = await res.json();
  return data.result;
}

async function getThread(id: string) {
  const raw = await redisCmd("get", "thread:" + id);
  return raw ? JSON.parse(raw) : null;
}

async function setThread(id: string, thread: unknown) {
  await redisCmd("set", "thread:" + id, JSON.stringify(thread));
  await redisCmd("sadd", "thread_index", id);
}

type Provider = "b2" | "r2";

function endpointFor(p: Provider): string {
  return p === "b2" ? `https://${B2_ENDPOINT}` : `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}
function bucketFor(p: Provider): string {
  return p === "b2" ? B2_BUCKET : R2_BUCKET;
}
function clientFor(p: Provider): AwsClient {
  return p === "b2"
    ? new AwsClient({ accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY, region: B2_REGION, service: "s3" })
    : new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_KEY, region: "auto", service: "s3" });
}
async function presignUrl(p: Provider, key: string, method: "PUT" | "GET" | "DELETE", contentType?: string): Promise<string> {
  const client = clientFor(p);
  const url = new URL(`${endpointFor(p)}/${bucketFor(p)}/${key}`);
  url.searchParams.set("X-Amz-Expires", "600");
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  const signed = await client.sign(new Request(url, { method, headers }), { aws: { signQuery: true } });
  return signed.url;
}
async function deleteObject(p: Provider, key: string) {
  const url = await presignUrl(p, key, "DELETE");
  await fetch(url, { method: "DELETE" });
}
async function getStorageUsage(): Promise<number> {
  const v = await redisCmd("get", "storage_usage_bytes");
  return v ? Number(v) : 0;
}
async function addStorageUsage(delta: number) {
  await redisCmd("incrby", "storage_usage_bytes", String(delta));
}
async function cleanupExpiredFiles() {
  const now = Date.now();
  const ids: string[] = (await redisCmd("smembers", "thread_index")) || [];
  for (const id of ids) {
    const thread = await getThread(id);
    if (!thread) continue;
    let changed = false;
    for (const m of thread.messages) {
      if (m.attachment && (now - m.attachment.uploadedAt) > FILE_TTL_MS) {
        try {
          await deleteObject(m.attachment.provider, m.attachment.key);
          await addStorageUsage(-m.attachment.fileSize);
        } catch (_e) { /* best effort */ }
        delete m.attachment;
        m.text = (m.text ? m.text + " " : "") + "[attachment expired]";
        changed = true;
      }
    }
    if (changed) await setThread(id, thread);
  }
}
async function maybeCleanup() {
  const last = await redisCmd("get", "last_cleanup");
  const lastNum = last ? Number(last) : 0;
  if (Date.now() - lastNum > 60 * 60 * 1000) {
    await redisCmd("set", "last_cleanup", String(Date.now()));
    await cleanupExpiredFiles();
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === "/health") return json({ status: "ok" });

  if (url.pathname === "/message" && req.method === "POST") {
    await maybeCleanup();
    const body = await req.json();
    const text = (body.text || "").trim();
    const attachment = body.attachment ? {
      key: String(body.attachment.key), provider: body.attachment.provider as Provider,
      fileName: String(body.attachment.fileName || "file"), fileType: String(body.attachment.fileType || "application/octet-stream"),
      fileSize: Number(body.attachment.fileSize || 0), uploadedAt: Date.now(),
    } : null;
    if (!text && !attachment) return json({ success: false }, 400);
    const msg: any = { from: "customer", text, time: Date.now() };
    if (attachment) msg.attachment = attachment;
    let thread: any;
    if (body.threadId) {
      thread = await getThread(body.threadId);
    }
    if (thread) {
      thread.messages.push(msg);
    } else {
      const id = crypto.randomUUID();
      thread = { id, from: (body.name || "Anonymous").trim(), email: (body.email || "").trim(), time: Date.now(), messages: [msg] };
    }
    await setThread(thread.id, thread);
    if (attachment) await addStorageUsage(attachment.fileSize);
    return json({ success: true, threadId: thread.id });
  }

  if (url.pathname === "/thread" && req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    const thread = await getThread(id);
    if (!thread) return json({ found: false });
    return json({ found: true, name: thread.from, messages: thread.messages });
  }

  if (url.pathname === "/reply" && req.method === "POST") {
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) return json({ success: false }, 401);
    const body = await req.json();
    const thread = await getThread(body.id);
    if (!thread) return json({ success: false }, 404);
    const attachment = body.attachment ? {
      key: String(body.attachment.key), provider: body.attachment.provider as Provider,
      fileName: String(body.attachment.fileName || "file"), fileType: String(body.attachment.fileType || "application/octet-stream"),
      fileSize: Number(body.attachment.fileSize || 0), uploadedAt: Date.now(),
    } : null;
    const msg: any = { from: "admin", text: body.reply, time: Date.now() };
    if (attachment) { msg.attachment = attachment; await addStorageUsage(attachment.fileSize); }
    thread.messages.push(msg);
    await setThread(thread.id, thread);
    return json({ success: true, email: thread.email });
  }

  if (url.pathname === "/messages" && req.method === "GET") {
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) return json({ success: false }, 401);
    const ids: string[] = (await redisCmd("smembers", "thread_index")) || [];
    const all = [];
    for (const id of ids) {
      const t = await getThread(id);
      if (t) all.push(t);
    }
    return json(all);
  }

  if (url.pathname === "/messages" && req.method === "DELETE") {
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) return json({ success: false }, 401);
    const ids: string[] = (await redisCmd("smembers", "thread_index")) || [];
    let count = 0;
    for (const id of ids) {
      await redisCmd("del", "thread:" + id);
      count++;
    }
    await redisCmd("del", "thread_index");
    return json({ success: true, deleted: count });
  }

  if (url.pathname === "/upload-url" && req.method === "POST") {
    const body = await req.json();
    const fileName = String(body.fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileType = String(body.fileType || "application/octet-stream");
    const fileSize = Number(body.fileSize || 0);
    if (!fileSize || fileSize > MAX_UPLOAD_BYTES) return json({ error: "Invalid file size, 25MB max" }, 400);
    const usage = await getStorageUsage();
    const provider: Provider = (usage + fileSize) < B2_LIMIT_BYTES ? "b2" : "r2";
    const key = `${crypto.randomUUID()}-${fileName}`;
    const uploadUrl = await presignUrl(provider, key, "PUT", fileType);
    return json({ uploadUrl, key, provider, fileType, fileName, fileSize, expiresIn: 600 });
  }

  if (url.pathname === "/file-url" && req.method === "GET") {
    const threadId = url.searchParams.get("threadId") || "";
    const key = url.searchParams.get("key") || "";
    const provider = (url.searchParams.get("provider") || "b2") as Provider;
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) {
      const thread = await getThread(threadId);
      const found = thread?.messages?.some((m: any) => m.attachment?.key === key);
      if (!found) return json({ error: "Not found" }, 404);
    }
    const dlUrl = await presignUrl(provider, key, "GET");
    return json({ url: dlUrl, expiresIn: 600 });
  }

  return json({ error: "Not found" }, 404);
});
