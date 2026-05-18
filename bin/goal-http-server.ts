#!/usr/bin/env node
/**
 * goal-http-server — local HTTP shim over the v3 .goal/ tree.
 *
 * Loopback-only (127.0.0.1). Invoked by `goalctl serve-http`.
 *
 * Endpoints (all goal-scoped endpoints resolve which goal to operate on via
 * a 3-tier lookup: `?goal=<gid>` query param → `X-Claude-Session-Id` header
 * → the project's single non-terminal goal):
 *
 *   GET   /goal[?goal=<gid>]      → 200 goal-json | 404 no_active_goal | 409 goal_ambiguous
 *   POST  /goal                   → 201 goal-json | 409 goal_exists_and_active
 *                                   Body: {objective: string, token_budget?: number}
 *                                   Header X-Claude-Session-Id: bind this session to the new goal.
 *   PATCH /goal[?goal=<gid>]      → 200 goal-json | 400 invalid action | 404 no goal | 409 goal_ambiguous
 *                                   Body: {action: "pause"|"resume"|"clear"|"set-budget"|"mark-needs-input", value?: any}
 *                                   `clear` → 204 No Content.
 *   GET   /goals                  → 200 {goals:[{goal_id,status,objective,updated_at}, …]}
 *   GET   /events?since=<iso>     → application/x-ndjson stream of .goal/events.jsonl
 *
 * v3 on-disk layout (per-goal records, session pointers, per-goal locks):
 *   <root>/.goal/goals/<gid>.json
 *   <root>/.goal/sessions/<sid>      pointer text = gid
 *   <root>/.goal/locks/<gid>.lock    per-goal mkdir mutex (same path the MCP + hooks use)
 *   <root>/.goal/locks/_coord.lock   project-coordination lock
 *   <root>/.goal/events.jsonl
 *   <root>/.claude/goal-baseline-<goal_id>   (cleared on create/replace/clear)
 *
 * Atomic writes via mktemp-in-same-dir + rename. CAS via goal_id check
 * between read and write. v1→v2→v3 forward migration on first touch.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { URL } from "node:url";
import lockfile from "proper-lockfile";

// ---- types ----------------------------------------------------------------

// v2 adds relaying and queued; readers must tolerate them.
type GoalStatus = "pursuing" | "paused" | "achieved" | "needs-input" | "budget-limited" | "relaying" | "queued";

interface HistoryEntry {
    ts: string;
    action: string;
    note: string;
}

interface Goal {
    // v2 fields (additive; optional for v1 compat reads)
    schema_version?: number;
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
    // v2 additive fields
    compat?: string[];
    roles?: { lead: string | null; build: string | null; review: string | null } | null;
    current?: { agent: string | null; session: string | null; since: string | null } | null;
    budget?: { kind: string; limit: number; used: number } | null;
    lineage?: Array<{ agent: string; model: string; started_at: string; ended_at: string | null; turns: number; tokens: number; summary: string }>;
    audit?: { checklist: Array<{ id: string; predicate: string; status: string; evidence: string | null }> } | null;
    handoff_head?: string | null;
    queued_until?: string | null;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run any pending v1→v2→v3 forward migration on the .goal/ tree. Idempotent.
 * Mirrors the MCP server's migrateIfNeeded byte-for-byte. Respects
 * GOAL_DISABLE_MIGRATION=1.
 */
async function migrateForward(root: string): Promise<void> {
    if (process.env.GOAL_DISABLE_MIGRATION === "1") return;
    const claudeDir = path.join(root, ".claude");
    const goalDir = path.join(root, ".goal");
    const goalsDir = path.join(goalDir, "goals");
    const v1File = path.join(claudeDir, "goal.json");
    const v2File = path.join(goalDir, "state.json");

    // Stage 1: v1 → v2 (rare).
    if (await fileExists(v1File) && !(await dirExists(goalDir))) {
        await migrateV1ToV2(root);
    }

    // Stage 2: v2 → v3 (the common case post-merge).
    if (await fileExists(v2File)) {
        await migrateV2ToV3(root, v2File, goalsDir);
    }
}

async function fileExists(p: string): Promise<boolean> {
    try { const s = await fsp.lstat(p); return s.isFile() && !s.isSymbolicLink(); }
    catch { return false; }
}
async function dirExists(p: string): Promise<boolean> {
    try { const s = await fsp.lstat(p); return s.isDirectory() && !s.isSymbolicLink(); }
    catch { return false; }
}

async function migrateV1ToV2(root: string): Promise<void> {
    const claudeDir = path.join(root, ".claude");
    const goalDir = path.join(root, ".goal");
    const v1File = path.join(claudeDir, "goal.json");
    const v2File = path.join(goalDir, "state.json");
    const markerFile = path.join(claudeDir, "MIGRATED_TO_GOAL");

    let v1Raw: Record<string, unknown>;
    try {
        const raw = await fsp.readFile(v1File, "utf8");
        v1Raw = JSON.parse(raw) as Record<string, unknown>;
    } catch { return; }

    const v1Status = typeof v1Raw.status === "string" ? v1Raw.status : "pursuing";
    const v1Ticks = typeof v1Raw.tick_count === "number" ? v1Raw.tick_count : 0;
    const v1Tokens = typeof v1Raw.tokens_used === "number" ? v1Raw.tokens_used : 0;
    const nowTs = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const v1Created = typeof v1Raw.created_at === "string" ? v1Raw.created_at : nowTs;
    const v1Updated = typeof v1Raw.updated_at === "string" ? v1Raw.updated_at : nowTs;
    const isActive = v1Status === "pursuing" || v1Status === "paused";

    const v2State = {
        ...v1Raw,
        schema_version: 2,
        compat: ["claude-code"],
        roles: { lead: null, build: null, review: null },
        current: { agent: null, session: null, since: null },
        budget: null,
        lineage: [{
            agent: "claude-code", model: "unknown",
            started_at: v1Created, ended_at: isActive ? null : v1Updated,
            turns: v1Ticks, tokens: v1Tokens, summary: "migrated from v1",
        }],
        audit: null, handoff_head: null, queued_until: null,
    };

    await fsp.mkdir(goalDir, { recursive: true });
    const tmpFile = path.join(goalDir, `state.json.${process.pid}.tmp`);
    try {
        await fsp.writeFile(tmpFile, JSON.stringify(v2State, null, 2) + "\n", "utf8");
        await fsp.rename(tmpFile, v2File);
    } catch (err) {
        try { await fsp.unlink(tmpFile); } catch { /* ignore */ }
        process.stderr.write(`goal-http-server: v1→v2 migration failed: ${(err as Error)?.message}\n`);
        return;
    }
    try { await fsp.rm(path.join(claudeDir, "goal.lock"), { recursive: true, force: true }); } catch {}
    try { await fsp.writeFile(markerFile, nowTs + "\n", "utf8"); } catch {}
}

async function migrateV2ToV3(root: string, v2File: string, goalsDir: string): Promise<void> {
    let raw: Record<string, unknown>;
    try {
        const txt = await fsp.readFile(v2File, "utf8");
        raw = JSON.parse(txt) as Record<string, unknown>;
    } catch (e) {
        process.stderr.write(`goal-http-server: v2→v3 parse failed: ${(e as Error)?.message}\n`);
        return;
    }
    const gid = typeof raw.goal_id === "string" ? raw.goal_id : "";
    if (!UUID_RE.test(gid)) {
        process.stderr.write(`goal-http-server: v2→v3 skipped — invalid goal_id "${gid}"\n`);
        return;
    }
    await fsp.mkdir(goalsDir, { recursive: true });
    const target = path.join(goalsDir, `${gid}.json`);
    try {
        // If the v3 record already exists (idempotent re-run, or another writer
        // migrated first), drop the legacy file and exit.
        if (await fileExists(target)) {
            try { await fsp.unlink(v2File); } catch {}
            return;
        }
        await fsp.rename(v2File, target);
        // Emit a one-line event so the MCP/dashboards see it.
        const eventsFile = path.join(path.dirname(goalsDir), "events.jsonl");
        const line = JSON.stringify({
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            type: "goal.migrated",
            goal_id: gid,
            note: "v2 state.json → v3 goals/<gid>.json (unowned; bind via /goal adopt)",
        }) + "\n";
        try { await fsp.appendFile(eventsFile, line, "utf8"); } catch {}
    } catch (err) {
        process.stderr.write(`goal-http-server: v2→v3 rename failed: ${(err as Error)?.message}\n`);
    }
}

class Store {
    readonly root: string;
    readonly claudeDir: string;
    readonly goalDir: string;
    readonly goalsDir: string;
    readonly sessionsDir: string;
    readonly locksDir: string;
    readonly eventsFile: string;

    constructor(root: string) {
        this.root = root;
        this.claudeDir = path.join(root, ".claude");
        this.goalDir = path.join(root, ".goal");
        this.goalsDir = path.join(this.goalDir, "goals");
        this.sessionsDir = path.join(this.goalDir, "sessions");
        this.locksDir = path.join(this.goalDir, "locks");
        this.eventsFile = path.join(this.goalDir, "events.jsonl");
    }

    static async create(root: string): Promise<Store> {
        await migrateForward(root);
        const s = new Store(root);
        await s.ensureDirs();
        return s;
    }

    async ensureDirs(): Promise<void> {
        await fsp.mkdir(this.claudeDir, { recursive: true });
        await fsp.mkdir(this.goalDir, { recursive: true });
        await fsp.mkdir(this.goalsDir, { recursive: true });
        await fsp.mkdir(this.sessionsDir, { recursive: true });
        await fsp.mkdir(this.locksDir, { recursive: true });
    }

    goalRecordPath(gid: string): string { return path.join(this.goalsDir, `${gid}.json`); }
    sessionPointerPath(sid: string): string { return path.join(this.sessionsDir, sid); }
    goalLockfilePath(gid: string): string { return path.join(this.locksDir, `${gid}.lock`); }
    coordLockfilePath(): string { return path.join(this.locksDir, "_coord.lock"); }

    /**
     * Acquire a per-goal lock at .goal/locks/<gid>.lock. Coordinates with the
     * MCP server (proper-lockfile, same path) and the bash hooks (mkdir mutex,
     * same path).
     */
    async withGoalLock<T>(gid: string, fn: () => Promise<T>): Promise<T> {
        await this.ensureDirs();
        const lockfilePath = this.goalLockfilePath(gid);
        const release = await lockfile.lock(this.locksDir, {
            lockfilePath,
            retries: { retries: 50, minTimeout: 50, maxTimeout: 250, factor: 1.5 },
            stale: 30_000,
            realpath: false,
        });
        try { return await fn(); }
        finally { try { await release(); } catch {} }
    }

    /**
     * Acquire the project-coordination lock. Used for create_goal (which doesn't
     * yet have a gid) and other cross-goal operations.
     */
    async withCoordLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureDirs();
        const lockfilePath = this.coordLockfilePath();
        const release = await lockfile.lock(this.locksDir, {
            lockfilePath,
            retries: { retries: 50, minTimeout: 50, maxTimeout: 250, factor: 1.5 },
            stale: 30_000,
            realpath: false,
        });
        try { return await fn(); }
        finally { try { await release(); } catch {} }
    }

    async readGoal(gid: string): Promise<Goal | null> {
        try {
            const raw = await fsp.readFile(this.goalRecordPath(gid), "utf8");
            return JSON.parse(raw) as Goal;
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
    }

    /**
     * Atomic write: mktemp in same dir, write, rename. If expectedGoalId is
     * given, performs CAS — fails with Error("cas_mismatch") if the on-disk
     * goal_id no longer matches.
     */
    async writeGoal(goal: Goal, expectedGoalId?: string): Promise<void> {
        const file = this.goalRecordPath(goal.goal_id);
        if (expectedGoalId !== undefined) {
            const cur = await this.readGoal(goal.goal_id);
            if (!cur || cur.goal_id !== expectedGoalId) {
                throw new Error("cas_mismatch");
            }
        }
        await this.ensureDirs();
        const tmp = path.join(
            this.goalsDir,
            `.state.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
        );
        await fsp.writeFile(tmp, JSON.stringify(goal, null, 2) + "\n", "utf8");
        await fsp.rename(tmp, file);
    }

    async unlinkGoal(gid: string): Promise<void> {
        try { await fsp.unlink(this.goalRecordPath(gid)); }
        catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        // Also drop any session pointers naming this gid + the per-goal lock dir.
        try {
            const entries = await fsp.readdir(this.sessionsDir);
            await Promise.all(entries.map(async (n) => {
                try {
                    const txt = (await fsp.readFile(path.join(this.sessionsDir, n), "utf8")).trim();
                    if (txt === gid) await fsp.unlink(path.join(this.sessionsDir, n));
                } catch {}
            }));
        } catch {}
        try { await fsp.rm(this.goalLockfilePath(gid), { recursive: true, force: true }); } catch {}
    }

    async writeSessionPointer(sid: string, gid: string): Promise<void> {
        await this.ensureDirs();
        const ptr = this.sessionPointerPath(sid);
        const tmp = path.join(this.sessionsDir, `.ptr.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
        await fsp.writeFile(tmp, gid + "\n", "utf8");
        await fsp.rename(tmp, ptr);
    }

    async readSessionPointer(sid: string): Promise<string | null> {
        try {
            const txt = (await fsp.readFile(this.sessionPointerPath(sid), "utf8")).trim();
            return UUID_RE.test(txt) ? txt : null;
        } catch { return null; }
    }

    /**
     * List every v3 goal record. Used for `GET /goals` and for the
     * single-active resolution fallback.
     */
    async listGoals(): Promise<Goal[]> {
        let entries: string[] = [];
        try { entries = await fsp.readdir(this.goalsDir); }
        catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw err;
        }
        const out: Goal[] = [];
        for (const name of entries) {
            if (!name.endsWith(".json") || name.startsWith(".")) continue;
            const gid = name.slice(0, -5);
            if (!UUID_RE.test(gid)) continue;
            const g = await this.readGoal(gid).catch(() => null);
            if (g) out.push(g);
        }
        return out;
    }

    /**
     * Resolve which goal a request operates on. Order:
     *   1) `?goal=<gid>` query param
     *   2) `X-Claude-Session-Id` header → sessions/<sid> pointer
     *   3) Exactly one non-terminal goal in the project (single-active)
     * Returns { gid } on success, or { error, status } on failure.
     */
    async resolveRequestGoal(req: http.IncomingMessage, url: URL): Promise<{ gid: string } | { error: string; status: number }> {
        // 1) explicit gid
        const qgid = url.searchParams.get("goal");
        if (qgid !== null) {
            if (!UUID_RE.test(qgid)) return { error: "invalid_goal_id", status: 400 };
            if (!(await this.readGoal(qgid))) return { error: "no_active_goal", status: 404 };
            return { gid: qgid };
        }
        // 2) session pointer
        const sid = headerString(req, "x-claude-session-id") ?? headerString(req, "x-goal-session-id");
        if (sid) {
            const gid = await this.readSessionPointer(sid);
            if (gid && (await this.readGoal(gid))) return { gid };
        }
        // 3) single-active fallback
        const actives = (await this.listGoals()).filter((g) =>
            g.status === "pursuing" || g.status === "paused" ||
            g.status === "needs-input" || g.status === "relaying" || g.status === "queued",
        );
        if (actives.length === 1) return { gid: actives[0].goal_id };
        if (actives.length === 0) return { error: "no_active_goal", status: 404 };
        return { error: "goal_ambiguous", status: 409 };
    }

    async clearBaselines(gidForFilter?: string): Promise<void> {
        let entries: string[] = [];
        try { entries = await fsp.readdir(this.claudeDir); }
        catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
            throw err;
        }
        await Promise.all(
            entries
                .filter((n) => n.startsWith("goal-baseline-"))
                .filter((n) => !gidForFilter || n === `goal-baseline-${gidForFilter}` || n.startsWith(`goal-baseline-${gidForFilter}`))
                .map((n) =>
                    fsp.unlink(path.join(this.claudeDir, n)).catch(() => undefined),
                ),
        );
    }

    async appendEvent(evt: Record<string, unknown>): Promise<void> {
        await this.ensureDirs();
        await fsp.appendFile(
            this.eventsFile,
            JSON.stringify(evt) + "\n",
            "utf8",
        );
    }
}

function headerString(req: http.IncomingMessage, name: string): string | null {
    const v = req.headers[name];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string" && v[0].trim().length > 0) return v[0].trim();
    return null;
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
 * delta-accumulation in pause/mark-needs-input correct even on a file that was
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
    "mark-needs-input",
]);

async function handleGetGoal(
    store: Store,
    req: http.IncomingMessage,
    url: URL,
    res: http.ServerResponse,
): Promise<void> {
    const r = await store.resolveRequestGoal(req, url);
    if ("error" in r) { sendJson(res, r.status, { error: r.error }); return; }
    const g = await store.readGoal(r.gid);
    if (!g) { sendJson(res, 404, { error: "no_active_goal" }); return; }
    sendJson(res, 200, g);
}

async function handleListGoals(store: Store, res: http.ServerResponse): Promise<void> {
    const goals = await store.listGoals();
    sendJson(res, 200, {
        goals: goals.map((g) => ({
            goal_id: g.goal_id,
            status: g.status,
            objective: typeof g.objective === "string" ? g.objective.slice(0, 240) : "",
            updated_at: g.updated_at,
        })),
    });
}

async function handlePostGoal(
    store: Store,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { sendJson(res, parsed.status, { error: parsed.error }); return; }
    const body = parsed.value as { objective?: unknown; token_budget?: unknown };
    if (typeof body.objective !== "string" || body.objective.length === 0) {
        sendJson(res, 400, { error: "objective (string) is required" });
        return;
    }
    let budget: number | null = null;
    if (body.token_budget !== undefined && body.token_budget !== null) {
        const n = body.token_budget;
        if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
            sendJson(res, 400, { error: "token_budget must be a positive integer or null" });
            return;
        }
        budget = n;
    }
    const sid = headerString(req, "x-claude-session-id") ?? headerString(req, "x-goal-session-id");

    const result = await store.withCoordLock(async () => {
        // Refuse if this session already owns an active goal (RFC v3 §3:
        // one non-terminal goal per session).
        if (sid) {
            const ownedGid = await store.readSessionPointer(sid);
            if (ownedGid) {
                const existing = await store.readGoal(ownedGid);
                if (existing && (existing.status === "pursuing" || existing.status === "paused")) {
                    return { code: 409, body: { error: "goal_exists_and_active", existing_goal_id: ownedGid } };
                }
            }
        } else {
            // No session id — fall back to project-wide single-active check so
            // a non-Claude caller doesn't create a duplicate it could never
            // resolve.
            const actives = (await store.listGoals()).filter((g) =>
                g.status === "pursuing" || g.status === "paused");
            if (actives.length > 0) {
                return {
                    code: 409,
                    body: {
                        error: "goal_exists_and_active",
                        existing_goal_id: actives[0].goal_id,
                        hint: "send X-Claude-Session-Id header to bind a per-session goal",
                    },
                };
            }
        }

        const ts = nowIso();
        const newId = newGoalId();
        const goal: Goal = {
            schema_version: 2,
            goal_id: newId,
            objective: body.objective as string,
            status: "pursuing",
            created_at: ts,
            updated_at: ts,
            time_used_seconds: 0,
            observed_at: ts,
            active_turn_started_at: ts,
            tokens_used_observed_at: ts,
            time_used_seconds_final: null,
            tokens_used_final: null,
            token_budget: budget,
            tokens_used: 0,
            tick_count: 0,
            pursuing_seconds: 0,
            pursuing_since: ts,
            history: [{ ts, action: "create", note: "via http" }],
            compat: ["claude-code"],
            roles: { lead: null, build: null, review: null },
            current: { agent: null, session: sid ?? null, since: sid ? ts : null },
            budget: null,
            lineage: [],
            audit: null,
            handoff_head: null,
            queued_until: null,
        };
        await store.clearBaselines();
        await store.writeGoal(goal);
        if (sid) await store.writeSessionPointer(sid, newId);
        await store.appendEvent({
            ts, type: "goal.created",
            goal_id: goal.goal_id,
            objective: goal.objective,
            actor: "http",
            owner_session_id: sid ?? null,
            token_budget: goal.token_budget,
        }).catch(() => undefined);
        return { code: 201, body: goal };
    });
    sendJson(res, result.code, result.body);
}

async function handlePatchGoal(
    store: Store,
    req: http.IncomingMessage,
    url: URL,
    res: http.ServerResponse,
): Promise<void> {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { sendJson(res, parsed.status, { error: parsed.error }); return; }
    const body = parsed.value as { action?: unknown; value?: unknown };
    const action = body.action;
    if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
        sendJson(res, 400, { error: `action must be one of: ${Array.from(VALID_ACTIONS).join(", ")}` });
        return;
    }
    const r = await store.resolveRequestGoal(req, url);
    if ("error" in r) { sendJson(res, r.status, { error: r.error }); return; }
    const gid = r.gid;

    await store.withGoalLock(gid, async () => {
        const rawCur = await store.readGoal(gid);
        if (!rawCur) { sendJson(res, 404, { error: "no_active_goal" }); return; }
        const cur = normalizePursuitFields(rawCur);
        const ts = nowIso();

        try {
            if (action === "clear") {
                await store.unlinkGoal(gid);
                await store.clearBaselines(gid);
                await store.appendEvent({ ts, type: "goal.cleared", goal_id: cur.goal_id })
                    .catch(() => undefined);
                sendNoContent(res);
                return;
            }

            if (action === "pause") {
                if (cur.status !== "pursuing") {
                    sendJson(res, 400, { error: `can only pause a pursuing goal (current: ${cur.status})` });
                    return;
                }
                const acc = accumulateOnExit(cur);
                const next: Goal = {
                    ...pushHistory(cur, "pause", "via http", ts),
                    status: "paused",
                    pursuing_seconds: acc.pursuing_seconds,
                    pursuing_since: acc.pursuing_since,
                };
                await store.writeGoal(next, cur.goal_id);
                await store.appendEvent({ ts, type: "goal.paused", goal_id: next.goal_id })
                    .catch(() => undefined);
                sendJson(res, 200, next);
                return;
            }

            if (action === "resume") {
                if (cur.status !== "paused") {
                    sendJson(res, 400, { error: `can only resume a paused goal (current: ${cur.status})` });
                    return;
                }
                const next: Goal = {
                    ...pushHistory(cur, "resume", "via http", ts),
                    status: "pursuing",
                    pursuing_since: ts,
                };
                await store.writeGoal(next, cur.goal_id);
                await store.appendEvent({ ts, type: "goal.resumed", goal_id: next.goal_id })
                    .catch(() => undefined);
                sendJson(res, 200, next);
                return;
            }

            if (action === "set-budget") {
                const v = body.value;
                let newBudget: number | null;
                if (v === null) newBudget = null;
                else if (typeof v === "number" && Number.isInteger(v) && v > 0) newBudget = v;
                else {
                    sendJson(res, 400, { error: "set-budget: value must be a positive integer or null" });
                    return;
                }
                const note = newBudget === null ? "cleared" : String(newBudget);
                const next: Goal = {
                    ...pushHistory(cur, "set-budget", note, ts),
                    token_budget: newBudget,
                };
                await store.writeGoal(next, cur.goal_id);
                await store.appendEvent({
                    ts, type: "goal.budget_changed",
                    goal_id: next.goal_id, token_budget: newBudget,
                }).catch(() => undefined);
                sendJson(res, 200, next);
                return;
            }

            if (action === "mark-needs-input") {
                const note = typeof body.value === "string" && body.value.length > 0 ? body.value : "via http";
                const acc = accumulateOnExit(cur);
                const next: Goal = {
                    ...pushHistory(cur, "mark-needs-input", note, ts),
                    status: "needs-input",
                    pursuing_seconds: acc.pursuing_seconds,
                    pursuing_since: acc.pursuing_since,
                };
                await store.writeGoal(next, cur.goal_id);
                await store.appendEvent({ ts, type: "goal.needs_input", goal_id: next.goal_id, note })
                    .catch(() => undefined);
                sendJson(res, 200, next);
                return;
            }

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
    await store.ensureDirs();
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
    const shutdown: ShutdownState = { shuttingDown: false, events: new Set() };

    // Bootstrap: create the store (runs migration async, then starts server).
    Store.create(args.root).then((store) => {
        startServer(args, store, shutdown);
    }).catch((err: unknown) => {
        die(`failed to initialize store: ${(err as Error)?.message}`);
    });
}

function startServer(args: CliArgs, store: Store, shutdown: ShutdownState): void {

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
                await handleGetGoal(store, req, url, res);
                return;
            }
            if (route === "/goal" && method === "POST") {
                await handlePostGoal(store, req, res);
                return;
            }
            if (route === "/goal" && method === "PATCH") {
                await handlePatchGoal(store, req, url, res);
                return;
            }
            if (route === "/goals" && method === "GET") {
                await handleListGoals(store, res);
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
