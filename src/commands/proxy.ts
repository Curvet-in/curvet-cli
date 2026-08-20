import http from "node:http";
import { Readable } from "node:stream";
import { Command } from "commander";
import pc from "picocolors";
import { resolveProfile } from "../config.js";
import { requireAppKey, v1Root } from "../client.js";
import { ok, warn } from "../output.js";

/**
 * Routes worth proxying. Tools disagree about whether the base URL they are
 * given already ends in `/v1`, so accept both spellings of each path rather
 * than making the user guess which one their editor appends.
 */
const ROUTES: Array<{ method: string; match: RegExp; to: string }> = [
  { method: "POST", match: /^\/(v1\/)?chat\/completions$/, to: "/chat/completions" },
  { method: "GET", match: /^\/(v1\/)?models$/, to: "/models" },
  // A model id is one segment: `(.+)` would accept `/models/../../secret`,
  // which fetch normalises into a path outside the API surface — reachable with
  // the injected credential by anything that can talk to this port.
  { method: "GET", match: /^\/(v1\/)?models\/([^/]+)$/, to: "/models/$2" },
];

export function resolveRoute(method: string, pathname: string): string | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = pathname.match(route.match);
    if (!m) continue;
    const resolved = route.to.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
    // Belt and braces: nothing we forward may climb out of the base path.
    if (resolved.split("/").includes("..")) return undefined;
    return resolved;
  }
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The model name, for the log line only — never used to alter the request. */
function modelOf(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { model?: string };
    return parsed.model ?? "?";
  } catch {
    return "?";
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function proxyCommand(): Command {
  return new Command("proxy")
    .description("Run a local OpenAI-compatible endpoint that bills to Curvet")
    .option("-p, --port <port>", "port to listen on", (v) => parseInt(v, 10), 4141)
    .option("--host <host>", "interface to bind (default: loopback only)", "127.0.0.1")
    .option("--quiet", "do not log requests")
    .action(async (opts, cmd) => {
      const profile = await resolveProfile(cmd.optsWithGlobals().profile);
      const appKey = requireAppKey(profile);
      const upstream = v1Root(profile.baseURL);

      // This process holds a credential and hands it to anything that connects,
      // so the default bind is loopback. Widening it is a real exposure and is
      // said out loud rather than buried in --help.
      if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
        console.error(
          warn(
            `Binding to ${opts.host} exposes your Curvet key to anything that can reach this ` +
              "machine on that interface — every request it accepts is billed to your account.",
          ),
        );
      }

      const server = http.createServer(async (req, res) => {
        const started = Date.now();
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

        if (req.method === "GET" && pathname === "/health") {
          return sendJson(res, 200, { ok: true, upstream });
        }

        const target = resolveRoute(req.method ?? "GET", pathname);
        if (!target) {
          return sendJson(res, 404, {
            error: {
              message: `No route for ${req.method} ${pathname}. This proxy serves /v1/chat/completions and /v1/models.`,
              type: "invalid_request_error",
            },
          });
        }

        const body = req.method === "POST" ? await readBody(req) : undefined;

        try {
          const upstreamRes = await fetch(`${upstream}${target}`, {
            method: req.method,
            headers: {
              // The client's own Authorization header is deliberately dropped:
              // the point of the proxy is that the tool never holds a key, and
              // forwarding a stale or foreign one would fail confusingly.
              authorization: `Bearer ${appKey}`,
              ...(body ? { "content-type": "application/json" } : {}),
              accept: req.headers.accept ?? "*/*",
            },
            body,
          });

          const headers: Record<string, string> = {};
          for (const name of ["content-type", "cache-control", "x-request-id"]) {
            const value = upstreamRes.headers.get(name);
            if (value) headers[name] = value;
          }
          res.writeHead(upstreamRes.status, headers);

          if (upstreamRes.body) {
            // Piped rather than buffered, so SSE tokens reach the tool as they
            // arrive instead of all at once when the response ends.
            await new Promise<void>((resolve, reject) => {
              const stream = Readable.fromWeb(upstreamRes.body as never);
              stream.on("error", reject);
              res.on("close", resolve);
              stream.pipe(res).on("finish", resolve);
            });
          } else {
            res.end();
          }

          if (!opts.quiet) {
            const label = body ? ` ${modelOf(body)}` : "";
            const colour = upstreamRes.status < 400 ? pc.dim : pc.yellow;
            console.error(
              colour(`${req.method} ${pathname}${label} → ${upstreamRes.status} · ${Date.now() - started}ms`),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            sendJson(res, 502, {
              error: { message: `Upstream request failed: ${message}`, type: "api_error" },
            });
          } else {
            res.end();
          }
          if (!opts.quiet) console.error(pc.red(`${req.method} ${pathname} → ${message}`));
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, opts.host, resolve);
      });

      const base = `http://${opts.host}:${opts.port}/v1`;
      console.error(ok(`proxying ${base} → ${upstream}`));
      console.error(
        pc.dim(
          `  Point any OpenAI-compatible tool at ${base} with any API key — the key is injected here.\n` +
            `  OPENAI_BASE_URL=${base} OPENAI_API_KEY=unused\n` +
            "  Ctrl-C to stop.",
        ),
      );

      const stop = () => {
        server.close(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
}
