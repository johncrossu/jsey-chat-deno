const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";
const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL") || "";
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || "";

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

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === "/health") return json({ status: "ok" });

  if (url.pathname === "/message" && req.method === "POST") {
    const body = await req.json();
    const text = (body.text || "").trim();
    if (!text) return json({ success: false }, 400);
    let thread: any;
    if (body.threadId) {
      thread = await getThread(body.threadId);
    }
    if (thread) {
      thread.messages.push({ from: "customer", text, time: Date.now() });
    } else {
      const id = crypto.randomUUID();
      thread = { id, from: (body.name || "Anonymous").trim(), email: (body.email || "").trim(), time: Date.now(), messages: [{ from: "customer", text, time: Date.now() }] };
    }
    await setThread(thread.id, thread);
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
    thread.messages.push({ from: "admin", text: body.reply, time: Date.now() });
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

  return json({ error: "Not found" }, 404);
});
