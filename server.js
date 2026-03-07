const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = 3000;

const REQUEST_DELAY_MS = 1200;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

const MAX_429_ROUNDS = 4;
const ROUND_429_COOLDOWN_MS = 30000;

const REQUEST_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

function classifySteamResponse(status, body) {
  const lower = (body || "").toLowerCase();

  const isSteamErrorPage =
    lower.includes("<title>steam community :: error</title>") ||
    lower.includes("<h2>error</h2>") ||
    lower.includes("there was a problem accessing the item") ||
    lower.includes("an error was encountered while processing your request");

  const looksLikeWorkshopPage =
    lower.includes("sharedfiles/filedetails") ||
    lower.includes("steamcommunity.com/sharedfiles") ||
    lower.includes("workshopitemtitle") ||
    lower.includes("subscribeitembtn") ||
    lower.includes("collectionitem");

  if (status === 404) return { kind: "missing", reason: "HTTP 404" };
  if (status === 429) return { kind: "rate_limited", reason: "HTTP 429" };
  if (status >= 500) return { kind: "server_error", reason: `HTTP ${status}` };
  if (isSteamErrorPage) return { kind: "missing", reason: "Steam error page content" };
  if (status >= 200 && status < 300 && looksLikeWorkshopPage) return { kind: "ok", reason: `HTTP ${status}` };
  if (status >= 200 && status < 300) return { kind: "unknown", reason: `HTTP ${status}, page did not clearly look like a workshop item` };
  if (status >= 300 && status < 400) return { kind: "redirect", reason: `HTTP ${status}` };
  if (status >= 400) return { kind: "client_error", reason: `HTTP ${status}` };

  return { kind: "unknown", reason: `Unrecognized response (HTTP ${status})` };
}

function fetchSteamPage(id) {
  return new Promise((resolve) => {
    const target = new URL(workshopUrl(id));

    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024) {
            body = body.slice(0, 2 * 1024 * 1024);
          }
        });

        res.on("end", () => {
          resolve({
            id,
            url: target.toString(),
            status: res.statusCode || null,
            headers: res.headers || {},
            body
          });
        });
      }
    );

    req.on("error", (err) => {
      resolve({
        id,
        url: target.toString(),
        status: null,
        headers: {},
        body: "",
        error: err.message
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.end();
  });
}

async function checkSteamUrl(id, onAttempt) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt += 1;
    if (onAttempt) onAttempt({ id, attempt, phase: "requesting" });

    const response = await fetchSteamPage(id);

    if (response.error) {
      return {
        id,
        url: response.url,
        status: null,
        state: "error",
        reason: response.error,
        attempts: attempt
      };
    }

    const classification = classifySteamResponse(response.status, response.body);

    if (classification.kind === "rate_limited") {
      if (attempt < MAX_RETRIES) {
        if (onAttempt) {
          onAttempt({
            id,
            attempt,
            phase: "rate_limited",
            retryInMs: RETRY_DELAY_MS
          });
        }
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      return {
        id,
        url: response.url,
        status: response.status,
        state: "rate_limited",
        reason: classification.reason,
        attempts: attempt
      };
    }

    return {
      id,
      url: response.url,
      status: response.status,
      state: classification.kind,
      reason: classification.reason,
      attempts: attempt
    };
  }

  return {
    id,
    url: workshopUrl(id),
    status: null,
    state: "error",
    reason: "Exceeded retry limit",
    attempts: MAX_RETRIES
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/check") {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const ids = Array.isArray(parsed.ids)
          ? [...new Set(parsed.ids.map(String).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))]
          : [];

        if (!ids.length) {
          sendJson(res, 400, { error: "No valid numeric IDs provided." });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });

        const sendEvent = (event, payload) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const summary = {
          total: ids.length,
          completed: 0,
          ok: 0,
          missing: 0,
          unknown: 0,
          errors: 0,
          pending429: 0,
          final429: 0
        };

        sendEvent("start", { total: ids.length });

        const finalResultsById = new Map();
        let pendingQueue = [...ids];
        let round = 1;

        while (pendingQueue.length > 0 && round <= MAX_429_ROUNDS) {
          sendEvent("round", {
            round,
            totalRounds: MAX_429_ROUNDS,
            pendingCount: pendingQueue.length
          });

          const next429Queue = [];

          for (let i = 0; i < pendingQueue.length; i++) {
            const id = pendingQueue[i];

            sendEvent("progress", {
              current: summary.completed + 1,
              total: ids.length,
              id,
              phase: "queued",
              round
            });

            const result = await checkSteamUrl(id, (attemptInfo) => {
              sendEvent("progress", {
                current: summary.completed + 1,
                total: ids.length,
                id,
                round,
                ...attemptInfo
              });
            });

            if (result.state === "rate_limited") {
              next429Queue.push(id);
              summary.pending429 = next429Queue.length;

              sendEvent("deferred", {
                id,
                round,
                reason: result.reason,
                retryRound: round + 1,
                pendingCount: next429Queue.length
              });
            } else {
              finalResultsById.set(id, result);
              summary.completed += 1;

              if (result.state === "ok") summary.ok += 1;
              else if (result.state === "missing") summary.missing += 1;
              else if (result.state === "error" || result.state === "server_error" || result.state === "client_error") summary.errors += 1;
              else summary.unknown += 1;

              sendEvent("result", {
                result,
                summary
              });
            }

            if (i < pendingQueue.length - 1) {
              await sleep(REQUEST_DELAY_MS);
            }
          }

          pendingQueue = next429Queue;

          if (pendingQueue.length > 0 && round < MAX_429_ROUNDS) {
            sendEvent("cooldown", {
              round,
              nextRound: round + 1,
              pendingCount: pendingQueue.length,
              waitMs: ROUND_429_COOLDOWN_MS
            });

            await sleep(ROUND_429_COOLDOWN_MS);
          }

          round += 1;
        }

        if (pendingQueue.length > 0) {
          for (const id of pendingQueue) {
            const result = {
              id,
              url: workshopUrl(id),
              status: 429,
              state: "rate_limited_final",
              reason: `Still rate-limited after ${MAX_429_ROUNDS} rounds`,
              attempts: MAX_RETRIES * MAX_429_ROUNDS
            };

            finalResultsById.set(id, result);
            summary.completed += 1;
            summary.final429 += 1;

            sendEvent("result", {
              result,
              summary
            });
          }
        }

        summary.pending429 = 0;

        sendEvent("done", {
          summary,
          totalResults: finalResultsById.size
        });

        res.end();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });

    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});