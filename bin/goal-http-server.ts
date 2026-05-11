#!/usr/bin/env node
/**
 * goal-http-server — local HTTP shim over .claude/goal.json
 *
 * Loopback-only (127.0.0.1). Invoked by `goalctl serve-http`.
 *
 * Endpoints:
 *   GET   /goal                  → 200 goal-json | 404 {"error":"no_active_goal"}
 *   POST  /goal                  → 201 goal-json | 409 {"error":"goal_exists_and_active"}
 *                                  Body: {objective: string, token_budget?: number}
 *   PATCH /goal                  → 200 goal-json | 400 invalid action | 404 no goal
 *                                  Body: {action: "pause"|"resume"|"clear"|"set-budget"|"mark-unmet", value?: any}
 *                                  For "clear": returns 204 No Content.
 *   GET   /events?since=<iso>    → application/x-ndjson stream of events from
 *                                  .claude/goal-events.jsonl. Stays open and
 *                                  streams new lines.
 *
 * Storage layout (single source of truth — must stay in sync with bin/goalctl):
 *   <root>/.claude/goal.json
 *   <root>/.claude/goal-events.jsonl
 *   <root>/.claude/goal-baseline-<goal_id>   (cleared on create/replace/clear)
 *
 * Atomic writes via mktemp-in-same-dir + rename. CAS via goal_id check
 * between read and write.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { URL } from "node:url";
import lockfile from "proper-lockfile";

// ---- types ----------------------------------------------------------------

type GoalStatus = "pursuing" | "paused" | "achieved" | "unmet" | "budget-limited";

interface HistoryEntry {
    ts: string;
    action: string;
    note: string;
}

interface Goal {
    goal_id: string;
    objective: string;
    status: GoalStatus;
    created_at: string;
    updated_at: string;
    token_budget: number | null;
    tokens_used: number;
    tick_count: number;
    pursuing_seconds: number;
    pursuing_since: string | null;
    history: HistoryEntry[];
    [k: string]: unknown;
}

interface CliArgs {
    port: number;
    root: string;
}

// ---- argv parsing ---------------------------------------------------------

function parseArgs(argv: string[]): CliArgs {
    let port = 7474;
    let root = process.cwd();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--port") {
            const v = argv[++i];
            const n = Number(v);
            if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
                die(`invalid --port: ${v}`);
            }
            port = n;
        } else if (a === "--root") {
            const v = argv[++i];
            if (!v) die("--root requires a value");
            root = v;
        } else if (a === "-h" || a === "--help") {
            process.stdout.write(
                "usage: goal-http-server --port <N> --root <dir>\n",
            );
            process.exit(0);
        } else {
            die(`unknown arg: ${a}`);
        }
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        die(`--root: not a directory: ${root}`);
    }
    return { port, root };
}

function die(msg: string): never {
    process.stderr.write(`goal-http-server: ${msg}\n`);
    process.exit(1);
}

// ---- storage helpers ------------------------------------------------------

class Store {
    readonly file: string;
    readonly eventsFile: string;
    readonly dir: string;
    readonly root: string;

    constructor(root: string) {
        this.root = root;
        this.dir = path.join(root, ".claude");
        this.file = path.join(this.dir, "goal.json");
        this.eventsFile = path.join(this.dir, "goal-events.jsonl");
    }

    async ensureDir(): Promise<void> {
        await fsp.mkdir(this.dir, { recursive: true });
    }

    /**
     * Acquire the cross-writer lock at `.claude/goal.lock`, run `fn`, release.
     * Coordinates with the MCP server (proper-lockfile on the same lockfilePath)
     * and with the bash hooks / goalctl (mkdir-based mutex on the same dir).
     */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureDir();
        const release = await lockfile.lock(this.dir, {
            lockfilePath: path.join(this.dir, "goal.lock"),
            retries: { retries: 50, minTimeout: 50, maxTimeout: 250, factor: 1.5 },
            stale: 30_000,
        });
        try {
            return await fn();
        } finally {
            try {
                await release();
            } catch {
                /* lock already released or stolen */
            }
        }
    }

    async read(): Promise<Goal | null> {
        try {
            const raw = await fsp.readFile(this.file, "utf8");
            return JSON.parse(raw) as Goal;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
    }

    /**
     * Atomic write: mktemp in same dir, write, rename.
     * If expectedGoalId is given, performs CAS — fails with Error("cas_mismatch")
     * if the on-disk goal_id no longer matches.
     */
    async write(goal: Goal, expectedGoalId?: string): Promise<void> {
        if (expectedGoalId !== undefined) {
            const cur = await this.read();
            if (!cur || cur.goal_id !== expectedGoalId) {
                throw new Error("cas_mismatch");
            }
        }
        await this.ensureDir();
        const tmp = path.join(
            this.dir,
            `goal.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
        );
        await fsp.writeFile(tmp, JSON.stringify(goal, null, 2) + "\n", "utf8");
        await fsp.rename(tmp, this.file);
    }

    async unlink(): Promise<void> {
        try {
            await fsp.unlink(this.file);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
    }

    async clearBaselines(): Promise<void> {
        let entries: string[] = [];
        try {
            entries = await fsp.readdir(this.dir);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
            throw err;
        }
        await Promise.all(
            entries
                .filter((n) => n.startsWith("goal-baseline-"))
                .map((n) =>
                    fsp.unlink(path.join(this.dir, n)).catch(() => undefined),
                ),
        );
    }

    async appendEvent(evt: Record<string, unknown>): Promise<void> {
        await this.ensureDir();
        await fsp.appendFile(
            this.eventsFile,
            JSON.stringify(evt) + "\n",
            "utf8",
        );
    }
}

// ---- domain ops -----------------------------------------------------------

function nowIso(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function newGoalId(): string {
    return crypto.randomUUID();
}

function pushHistory(goal: Goal, action: string, note: string, ts: string): Goal {
    const history = Array.isArray(goal.history) ? goal.history.slice() : [];
    history.push({ ts, action, note });
    return { ...goal, history, updated_at: ts };
}

/**
 * Read goal as-is from disk but apply the same backward-compat seeding the
 * MCP server does: missing pursuing_seconds → 0, and on a pursuing legacy
 * file missing pursuing_since → seed from created_at. This keeps the
 * delta-accumulation in pause/mark-unmet correct even on a file that was
 * created by an old version.
 */
function normalizePursuitFields(g: Goal): Goal {
    const seconds = typeof g.pursuing_seconds === "number" && Number.isFinite(g.pursuing_seconds)
        ? Math.max(0, Math.floor(g.pursuing_seconds))
        : 0;
    let since: string | null;
    if (typeof g.pursuing_since === "string" && g.pursuing_since.length > 0) {
        since = g.pursuing_since;
    } else if (g.status === "pursuing" && typeof g.created_at === "string") {
        since = g.created_at;
    } else {
        since = null;
    }
    return { ...g, pursuing_seconds: seconds, pursuing_since: since };
}

/**
 * If `goal.status === "pursuing"` and pursuing_since is set, accumulate the
 * delta into pursuing_seconds and return {seconds, since:null}. Otherwise
 * return the existing values unchanged.
 */
function accumulateOnExit(goal: Goal): { pursuing_seconds: number; pursuing_since: string | null } {
    if (goal.status !== "pursuing" || goal.pursuing_since == null) {
        return { pursuing_seconds: goal.pursuing_seconds, pursuing_since: null };
    }
    const sinceMs = Date.parse(goal.pursuing_since);
    if (!Number.isFinite(sinceMs)) {
        return { pursuing_seconds: goal.pursuing_seconds, pursuing_since: null };
    }
    const delta = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
    return { pursuing_seconds: goal.pursuing_seconds + delta, pursuing_since: null };
}

// ---- request helpers ------------------------------------------------------

const MAX_BODY = 256 * 1024; // 256 KiB is plenty for a goal record

async function readJsonBody(
    req: http.IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
    const ct = (req.headers["content-type"] ?? "").toString().split(";")[0].trim();
    if (ct !== "application/json") {
        return {
            ok: false,
            error: "content-type must be application/json",
            status: 415,
        };
    }
    return await new Promise((resolve) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                resolve({ ok: false, error: "body too large", status: 413 });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (raw.length === 0) {
                resolve({ ok: true, value: {} });
                return;
            }
            try {
                resolve({ ok: true, value: JSON.parse(raw) });
            } catch {
                resolve({ ok: false, error: "invalid JSON", status: 400 });
            }
        });
        req.on("error", (e) =>
            resolve({ ok: false, error: e.message, status: 400 }),
        );
    });
}

function sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
): void {
    const buf = Buffer.from(JSON.stringify(body) + "\n", "utf8");
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": buf.length.toString(),
    });
    res.end(buf);
}

function sendText(
    res: http.ServerResponse,
    status: number,
    body: string,
    type = "text/plain; charset=utf-8",
): void {
    const buf = Buffer.from(body, "utf8");
    res.writeHead(status, {
        "Content-Type": type,
        "Content-Length": buf.length.toString(),
    });
    res.end(buf);
}

function sendNoContent(res: http.ServerResponse): void {
    res.writeHead(204);
    res.end();
}

// ---- handlers -------------------------------------------------------------

const VALID_ACTIONS = new Set([
    "pause",
    "resume",
    "clear",
    "set-budget",
    "mark-unmet",
]);

async function handleGetGoal(store: Store, res: http.ServerResponse): Promise<void> {
    const g = await store.read();
    if (!g) {
        sendJson(res, 404, { error: "no_active_goal" });
        return;
    }
    sendJson(res, 200, g);
}

async function handlePostGoal(
    store: Store,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
    }
    const body = parsed.value as { objective?: unknown; token_budget?: unknown };
    if (typeof body.objective !== "string" || body.objective.length === 0) {
        sendJson(res, 400, { error: "objective (string) is required" });
        return;
    }
    let budget: number | null = null;
    if (body.token_budget !== undefined && body.token_budget !== null) {
        const n = body.token_budget;
        if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
            sendJson(res, 400, {
                error: "token_budget must be a positive integer or null",
            });
            return;
        }
        budget = n;
    }

    const result = await store.withLock(async () => {
        const existing = await store.read();
        if (existing && (existing.status === "pursuing" || existing.status === "paused")) {
            return { code: 409, body: { error: "goal_exists_and_active" } };
        }
        const ts = nowIso();
        const goal: Goal = {
            goal_id: newGoalId(),
            objective: body.objective as string,
            status: "pursuing",
            created_at: ts,
            updated_at: ts,
            token_budget: budget,
            tokens_used: 0,
            tick_count: 0,
            pursuing_seconds: 0,
            pursuing_since: ts,
            history: [{ ts, action: existing ? "replace" : "create", note: "via http" }],
        };
        await store.clearBaselines();
        await store.write(goal);
        await store
            .appendEvent({
                ts,
                type: "goal.created",
                goal_id: goal.goal_id,
                objective: goal.objective,
                actor: "sdk",
                token_budget: goal.token_budget,
            })
            .catch(() => undefined);
        return { code: 201, body: goal };
    });
    sendJson(res, result.code, result.body);
}

async function handlePatchGoal(
    store: Store,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
    }
    const body = parsed.value as { action?: unknown; value?: unknown };
    const action = body.action;
    if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
        sendJson(res, 400, {
            error: `action must be one of: ${Array.from(VALID_ACTIONS).join(", ")}`,
        });
        return;
    }

    await store.withLock(async () => {
    const rawCur = await store.read();
    if (!rawCur) {
        sendJson(res, 404, { error: "no_active_goal" });
        return;
    }
    // Apply backward-compat seeding so transitions accumulate correctly even
    // on legacy files. Any writes use the normalized record as a base.
    const cur = normalizePursuitFields(rawCur);

    const ts = nowIso();

    try {
        if (action === "clear") {
            await store.unlink();
            await store.clearBaselines();
            await store
                .appendEvent({ ts, type: "goal.cleared", goal_id: cur.goal_id })
                .catch(() => undefined);
            sendNoContent(res);
            return;
        }

        if (action === "pause") {
            if (cur.status !== "pursuing") {
                sendJson(res, 400, {
                    error: `can only pause a pursuing goal (current: ${cur.status})`,
                });
                return;
            }
            const acc = accumulateOnExit(cur);
            const next: Goal = {
                ...pushHistory(cur, "pause", "via http", ts),
                status: "paused",
                pursuing_seconds: acc.pursuing_seconds,
                pursuing_since: acc.pursuing_since,
            };
            await store.write(next, cur.goal_id);
            await store
                .appendEvent({ ts, type: "goal.paused", goal_id: next.goal_id })
                .catch(() => undefined);
            sendJson(res, 200, next);
            return;
        }

        if (action === "resume") {
            if (cur.status !== "paused") {
                sendJson(res, 400, {
                    error: `can only resume a paused goal (current: ${cur.status})`,
                });
                return;
            }
            const next: Goal = {
                ...pushHistory(cur, "resume", "via http", ts),
                status: "pursuing",
                pursuing_since: ts,
            };
            await store.write(next, cur.goal_id);
            await store
                .appendEvent({ ts, type: "goal.resumed", goal_id: next.goal_id })
                .catch(() => undefined);
            sendJson(res, 200, next);
            return;
        }

        if (action === "set-budget") {
            const v = body.value;
            let newBudget: number | null;
            if (v === null) {
                newBudget = null;
            } else if (typeof v === "number" && Number.isInteger(v) && v > 0) {
                newBudget = v;
            } else {
                sendJson(res, 400, {
                    error: "set-budget: value must be a positive integer or null",
                });
                return;
            }
            const note = newBudget === null ? "cleared" : String(newBudget);
            // set-budget does NOT change status, so pursuit fields are unchanged
            // except that they may have been backfilled by normalizePursuitFields.
            const next: Goal = {
                ...pushHistory(cur, "set-budget", note, ts),
                token_budget: newBudget,
            };
            await store.write(next, cur.goal_id);
            await store
                .appendEvent({
                    ts,
                    type: "goal.budget_changed",
                    goal_id: next.goal_id,
                    token_budget: newBudget,
                })
                .catch(() => undefined);
            sendJson(res, 200, next);
            return;
        }

        if (action === "mark-unmet") {
            const note =
                typeof body.value === "string" && body.value.length > 0
                    ? body.value
                    : "via http";
            const acc = accumulateOnExit(cur);
            const next: Goal = {
                ...pushHistory(cur, "mark-unmet", note, ts),
                status: "unmet",
                pursuing_seconds: acc.pursuing_seconds,
                pursuing_since: acc.pursuing_since,
            };
            await store.write(next, cur.goal_id);
            await store
                .appendEvent({ ts, type: "goal.unmet", goal_id: next.goal_id, note })
                .catch(() => undefined);
            sendJson(res, 200, next);
            return;
        }

        // unreachable
        sendJson(res, 400, { error: "unhandled action" });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "cas_mismatch") {
            sendJson(res, 409, { error: "goal_id_mismatch" });
            return;
        }
        throw err;
    }
    });
}

async function handleEvents(
    store: Store,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    shutdown: ShutdownState,
): Promise<void> {
    const since = url.searchParams.get("since");
    let sinceMs: number | null = null;
    if (since !== null) {
        const t = Date.parse(since);
        if (Number.isNaN(t)) {
            sendJson(res, 400, { error: "invalid 'since' (must be ISO-8601)" });
            return;
        }
        sinceMs = t;
    }

    // ensure file exists so fs.watch is happy
    await store.ensureDir();
    try {
        await fsp.access(store.eventsFile);
    } catch {
        await fsp.writeFile(store.eventsFile, "", "utf8");
    }

    res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    let offset = 0;
    let leftover = "";
    let closed = false;
    let watcher: fs.FSWatcher | null = null;

    const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (watcher) {
            try {
                watcher.close();
            } catch {
                /* ignore */
            }
            watcher = null;
        }
        shutdown.events.delete(cleanup);
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    shutdown.events.add(cleanup);

    const matchesSince = (line: string): boolean => {
        if (sinceMs === null) return true;
        try {
            const obj = JSON.parse(line) as { ts?: string };
            if (!obj.ts) return true;
            const t = Date.parse(obj.ts);
            if (Number.isNaN(t)) return true;
            return t >= sinceMs;
        } catch {
            return true;
        }
    };

    const drain = async (): Promise<void> => {
        if (closed) return;
        let stat: fs.Stats;
        try {
            stat = await fsp.stat(store.eventsFile);
        } catch {
            return;
        }
        if (stat.size < offset) {
            // file truncated/rotated — restart
            offset = 0;
            leftover = "";
        }
        if (stat.size <= offset) return;
        const fd = await fsp.open(store.eventsFile, "r");
        try {
            const len = stat.size - offset;
            const buf = Buffer.alloc(len);
            await fd.read(buf, 0, len, offset);
            offset = stat.size;
            const text = leftover + buf.toString("utf8");
            const lines = text.split("\n");
            leftover = lines.pop() ?? "";
            for (const line of lines) {
                if (closed) return;
                if (line.length === 0) continue;
                if (!matchesSince(line)) continue;
                if (!res.write(line + "\n")) {
                    // backpressure — wait for drain
                    await new Promise<void>((resolve) => res.once("drain", resolve));
                }
            }
        } finally {
            await fd.close();
        }
    };

    await drain();
    if (closed) return;

    try {
        watcher = fs.watch(store.eventsFile, { persistent: false }, () => {
            drain().catch(() => undefined);
        });
        watcher.on("error", () => cleanup());
    } catch {
        // watch failed (rare on macOS for newly-created files) — fall back to poll
        const poll = setInterval(() => {
            if (closed) {
                clearInterval(poll);
                return;
            }
            drain().catch(() => undefined);
        }, 500);
        const origCleanup = cleanup;
        // replace the closure references inside the registered cleanup is awkward;
        // we just clear the poll on shutdown via the closed flag check above.
        void origCleanup;
    }
}

// ---- server lifecycle -----------------------------------------------------

interface ShutdownState {
    shuttingDown: boolean;
    events: Set<() => void>;
}

function logAccess(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    startNs: bigint,
): void {
    const dur = Number(process.hrtime.bigint() - startNs) / 1e6;
    const ip = req.socket.remoteAddress ?? "-";
    process.stderr.write(
        `[${nowIso()}] ${ip} ${req.method ?? "?"} ${req.url ?? "?"} ${res.statusCode} ${dur.toFixed(1)}ms\n`,
    );
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const store = new Store(args.root);
    const shutdown: ShutdownState = { shuttingDown: false, events: new Set() };

    const server = http.createServer((req, res) => {
        const startNs = process.hrtime.bigint();
        res.on("finish", () => logAccess(req, res, startNs));
        res.on("close", () => {
            if (!res.writableEnded) logAccess(req, res, startNs);
        });

        if (shutdown.shuttingDown) {
            sendJson(res, 503, { error: "shutting_down" });
            return;
        }

        let url: URL;
        try {
            url = new URL(req.url ?? "/", "http://127.0.0.1");
        } catch {
            sendJson(res, 400, { error: "invalid request URL" });
            return;
        }
        const method = (req.method ?? "GET").toUpperCase();
        const route = url.pathname;

        const dispatch = async (): Promise<void> => {
            if (route === "/goal" && method === "GET") {
                await handleGetGoal(store, res);
                return;
            }
            if (route === "/goal" && method === "POST") {
                await handlePostGoal(store, req, res);
                return;
            }
            if (route === "/goal" && method === "PATCH") {
                await handlePatchGoal(store, req, res);
                return;
            }
            if (route === "/events" && method === "GET") {
                await handleEvents(store, url, req, res, shutdown);
                return;
            }
            if (route === "/healthz" && method === "GET") {
                sendText(res, 200, "ok\n");
                return;
            }
            sendJson(res, 404, { error: "not_found" });
        };

        dispatch().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[error] ${msg}\n`);
            if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
            else res.end();
        });
    });

    server.on("clientError", (err, socket) => {
        try {
            socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        } catch {
            /* ignore */
        }
        void err;
    });

    server.listen(args.port, "127.0.0.1", () => {
        process.stderr.write(
            `goal-http-server listening on http://127.0.0.1:${args.port} (root=${args.root})\n`,
        );
    });

    const onSignal = (sig: string): void => {
        if (shutdown.shuttingDown) return;
        shutdown.shuttingDown = true;
        process.stderr.write(`\ngoal-http-server: received ${sig}, shutting down\n`);
        for (const fn of shutdown.events) {
            try {
                fn();
            } catch {
                /* ignore */
            }
        }
        server.close(() => process.exit(0));
        // hard exit if graceful close takes too long
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
}

main();
