const kv = await Deno.openKv();
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === "/message" && req.method === "POST") {
    const body = await req.json();
    const text = (body.text || "").trim();
    if (!text) return json({ success: false }, 400);
    let thread;
    if (body.threadId) {
      const entry = await kv.get(["threads", body.threadId]);
      thread = entry.value as any;
    }
    if (thread) {
      thread.messages.push({ from: "customer", text, time: Date.now() });
    } else {
      const id = crypto.randomUUID();
      thread = { id, from: (body.name || "Anonymous").trim(), email: (body.email || "").trim(), time: Date.now(), messages: [{ from: "customer", text, time: Date.now() }] };
    }
    await kv.set(["threads", thread.id], thread);
    return json({ success: true, threadId: thread.id });
  }

  if (url.pathname === "/thread" && req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    const entry = await kv.get(["threads", id]);
    if (!entry.value) return json({ found: false });
    const t = entry.value as any;
    return json({ found: true, name: t.from, messages: t.messages });
  }

  if (url.pathname === "/reply" && req.method === "POST") {
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) return json({ success: false }, 401);
    const body = await req.json();
    const entry = await kv.get(["threads", body.id]);
    const thread = entry.value as any;
    if (!thread) return json({ success: false }, 404);
    thread.messages.push({ from: "admin", text: body.reply, time: Date.now() });
    await kv.set(["threads", thread.id], thread);
    return json({ success: true, email: thread.email });
  }

  if (url.pathname === "/messages" && req.method === "GET") {
    const secret = req.headers.get("x-admin-secret");
    if (secret !== ADMIN_SECRET) return json({ success: false }, 401);
    const all = [];
    for await (const entry of kv.list({ prefix: ["threads"] })) all.push(entry.value);
    return json(all);
  }

  return json({ error: "Not found" }, 404);
});
