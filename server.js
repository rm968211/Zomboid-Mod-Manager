const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 3000;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30000;

const activeRuns = new Map();
let nextRunSequence = 1;

class CancelledError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

function createCancelState() {
  return { cancelled: false, listeners: new Set() };
}

function createRunId() {
  const id = `run-${Date.now()}-${nextRunSequence}`;
  nextRunSequence++;
  return id;
}

function cancelRun(cancelState) {
  if (cancelState.cancelled) return;
  cancelState.cancelled = true;
  for (const listener of [...cancelState.listeners]) listener();
  cancelState.listeners.clear();
}

function throwIfCancelled(cancelState) {
  if (cancelState.cancelled) throw new CancelledError();
}

function sleepWithCancel(ms, cancelState) {
  if (cancelState.cancelled) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onCancel = () => { cleanup(); reject(new CancelledError()); };
    const cleanup = () => { clearTimeout(timeout); cancelState.listeners.delete(onCancel); };
    cancelState.listeners.add(onCancel);
  });
}

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

function postRequest(urlStr, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    const bodyBuf = Buffer.from(body, "utf8");

    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": bodyBuf.length,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Request timed out")));
    req.write(bodyBuf);
    req.end();
  });
}

async function checkBatch(ids, cancelState) {
  throwIfCancelled(cancelState);

  const params = [`itemcount=${ids.length}`];
  ids.forEach((id, i) => params.push(`publishedfileids[${i}]=${encodeURIComponent(id)}`));

  const response = await postRequest(
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    params.join("&")
  );

  console.log(`[api] batch of ${ids.length} → HTTP ${response.status}`);

  if (response.status !== 200) {
    throw new Error(`Steam API returned HTTP ${response.status}`);
  }

  const json = JSON.parse(response.body);
  return json.response.publishedfiledetails || [];
}

function classifyDetail(detail) {
  if (!detail) return { state: "error", reason: "No detail in response" };
  const r = detail.result;
  if (r === 1) return { state: "ok", reason: "Item exists" };
  if (r === 9) return { state: "missing", reason: "Item not found (deleted or never existed)" };
  return { state: "unknown", reason: `Unexpected result code ${r}` };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end("Internal error"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.method === "POST" && req.url === "/control") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 256 * 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const runId = typeof parsed.runId === "string" ? parsed.runId.trim() : "";
        const action = typeof parsed.action === "string" ? parsed.action.trim() : "";

        if (!runId || !action) { sendJson(res, 400, { error: "runId and action are required." }); return; }

        const runState = activeRuns.get(runId);
        if (!runState) { sendJson(res, 404, { error: "Run not found." }); return; }

        if (action === "cancel") {
          cancelRun(runState.cancelState);
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 400, { error: "Unsupported action." });
        }
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/check") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      const cancelState = createCancelState();
      let runId = null;
      let sseStarted = false;
      let sendEvent = () => {};

      const handleDisconnect = () => cancelRun(cancelState);
      req.on("aborted", handleDisconnect);
      res.on("close", handleDisconnect);

      try {
        const parsed = JSON.parse(body || "{}");
        const ids = Array.isArray(parsed.ids)
          ? [...new Set(parsed.ids.map(String).map(s => s.trim()).filter(s => /^\d+$/.test(s)))]
          : [];

        if (!ids.length) { sendJson(res, 400, { error: "No valid numeric IDs provided." }); return; }

        runId = createRunId();
        activeRuns.set(runId, { id: runId, cancelState });

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
        sseStarted = true;

        sendEvent = (event, payload) => {
          if (cancelState.cancelled || res.writableEnded || res.destroyed) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        const summary = { total: ids.length, completed: 0, ok: 0, missing: 0, unknown: 0, errors: 0 };
        sendEvent("start", { total: ids.length, runId });

        const batches = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));

        for (let b = 0; b < batches.length; b++) {
          throwIfCancelled(cancelState);

          const batch = batches[b];
          sendEvent("round", { round: b + 1, totalRounds: batches.length, pendingCount: batch.length });
          sendEvent("progress", {
            current: summary.completed + 1,
            total: ids.length,
            id: `batch ${b + 1} of ${batches.length}`,
            phase: "requesting",
            round: b + 1,
            attempt: 1
          });

          const details = await checkBatch(batch, cancelState);
          const detailMap = new Map(details.map(d => [String(d.publishedfileid), d]));

          for (const id of batch) {
            throwIfCancelled(cancelState);
            const { state, reason } = classifyDetail(detailMap.get(id));

            summary.completed++;
            if (state === "ok") summary.ok++;
            else if (state === "missing") summary.missing++;
            else if (state === "error") summary.errors++;
            else summary.unknown++;

            sendEvent("result", {
              result: { id, url: workshopUrl(id), status: 200, state, reason, attempts: 1 },
              summary
            });
          }

          if (b < batches.length - 1) await sleepWithCancel(BATCH_DELAY_MS, cancelState);
        }

        sendEvent("done", { summary, totalResults: ids.length });
        if (!res.writableEnded) res.end();

      } catch (err) {
        if (err instanceof CancelledError || cancelState.cancelled) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (sseStarted) {
          sendEvent("fatal", { error: err.message });
          if (!res.writableEnded) res.end();
          return;
        }
        sendJson(res, 400, { error: err.message });
      } finally {
        if (runId) activeRuns.delete(runId);
      }
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
