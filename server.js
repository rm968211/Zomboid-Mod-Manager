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

class CancelledError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

function createCancelState() {
  return {
    cancelled: false,
    listeners: new Set()
  };
}

function cancelRun(cancelState) {
  if (cancelState.cancelled) return;

  cancelState.cancelled = true;

  for (const listener of [...cancelState.listeners]) {
    listener();
  }

  cancelState.listeners.clear();
}

function throwIfCancelled(cancelState) {
  if (cancelState.cancelled) {
    throw new CancelledError();
  }
}

function sleepWithCancel(ms, cancelState) {
  if (cancelState.cancelled) {
    return Promise.reject(new CancelledError());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onCancel = () => {
      cleanup();
      reject(new CancelledError());
    };

    const cleanup = () => {
      clearTimeout(timeout);
      cancelState.listeners.delete(onCancel);
    };

    cancelState.listeners.add(onCancel);
  });
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

function fetchSteamPage(id, cancelState) {
  return new Promise((resolve, reject) => {
    if (cancelState.cancelled) {
      reject(new CancelledError());
      return;
    }

    const target = new URL(workshopUrl(id));
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };

    const cleanup = () => {
      cancelState.listeners.delete(onCancel);
    };

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
          finish(resolve, {
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
      if (cancelState.cancelled || err instanceof CancelledError || err.message === "Run cancelled") {
        finish(reject, new CancelledError());
        return;
      }

      finish(resolve, {
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

    const onCancel = () => {
      req.destroy(new CancelledError());
      finish(reject, new CancelledError());
    };

    cancelState.listeners.add(onCancel);

    req.end();
  });
}

async function checkSteamUrl(id, onAttempt, cancelState) {
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    throwIfCancelled(cancelState);
    attempt += 1;
    if (onAttempt) onAttempt({ id, attempt, phase: "requesting" });

    const response = await fetchSteamPage(id, cancelState);

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
        await sleepWithCancel(RETRY_DELAY_MS, cancelState);
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
      const cancelState = createCancelState();
      let sseStarted = false;

      const handleDisconnect = () => {
        cancelRun(cancelState);
      };

      req.on("aborted", handleDisconnect);
      res.on("close", handleDisconnect);

      let sendEvent = () => {};

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

        sseStarted = true;

        sendEvent = (event, payload) => {
          if (cancelState.cancelled || res.writableEnded || res.destroyed) {
            return;
          }

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
          throwIfCancelled(cancelState);

          sendEvent("round", {
            round,
            totalRounds: MAX_429_ROUNDS,
            pendingCount: pendingQueue.length
          });

          const next429Queue = [];

          for (let i = 0; i < pendingQueue.length; i++) {
            throwIfCancelled(cancelState);

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
            }, cancelState);

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
              await sleepWithCancel(REQUEST_DELAY_MS, cancelState);
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

            await sleepWithCancel(ROUND_429_COOLDOWN_MS, cancelState);
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

        if (!res.writableEnded) {
          res.end();
        }
      } catch (err) {
        if (err instanceof CancelledError || cancelState.cancelled) {
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        if (sseStarted) {
          sendEvent("fatal", { error: err.message });
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

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
