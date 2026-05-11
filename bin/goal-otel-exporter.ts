#!/usr/bin/env node
/**
 * goal-otel-exporter — tail .claude/goal-events.jsonl and export as OTel metrics.
 *
 * Endpoint discovery:
 *   - GOAL_OTEL_ENDPOINT=https://collector.example/v1/metrics → OTLP/HTTP exporter
 *   - unset → fall back to stdout in OTLP/JSON form (useful for piping)
 *
 * Cursor file (resumable tail across restarts):
 *   <events_file>.cursor   — single line: last byte offset processed.
 *
 * Discovered events:
 *   goal.created           → counter goal.created
 *   goal.completed         → counter goal.completed + histograms (token_count,
 *                            elapsed_seconds, continuation_turns) when present
 *   goal.unmet             → counter goal.unmet
 *   goal.budget_limited    → counter goal.budget_limited
 *   goal.tokens_updated    → histogram goal.token_count (tokens_used, attr goal_id)
 *   goal.relayed           → counter goal.relayed (attrs: reason, from, to)
 *   goal.queued            → counter goal.queued (attr: providers_throttled)
 *   goal.handoff.peer_picked_up → histogram goal.handoff.gap_seconds
 *   goal.relay.recovery_seconds → histogram goal.relay.recovery_seconds
 *   goal.lane.conflict     → counter goal.lane.conflict
 *
 * Lifecycle: SIGINT / SIGTERM → flush and exit 0.
 *
 * Usage:
 *   bin/goal-otel-exporter [--events <path>] [--interval-ms <N>]
 *
 * Defaults:
 *   --events       <repo-root>/.claude/goal-events.jsonl
 *                  (or $GOAL_EVENTS_FILE if set)
 *   --interval-ms  10000 (metrics export interval; ignored for stdout)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { metrics, ValueType } from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

// ---- args -----------------------------------------------------------------

type Args = { events: string; intervalMs: number };

function parseArgs(argv: readonly string[]): Args {
  let events =
    process.env.GOAL_EVENTS_FILE ??
    findEventsFile(process.cwd()) ??
    path.join(process.cwd(), ".claude", "goal-events.jsonl");
  let intervalMs = 10_000;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--events" && i + 1 < argv.length) {
      events = path.resolve(argv[++i]!);
    } else if (a === "--interval-ms" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`invalid --interval-ms: ${argv[i]}`);
      }
      intervalMs = n;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }

  return { events, intervalMs };
}

function findEventsFile(startDir: string): string | undefined {
  // Walk up to find a `.claude/goal-events.jsonl` near a project root.
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".claude", "goal-events.jsonl");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function printHelp(): void {
  process.stdout.write(
    "Usage: goal-otel-exporter [--events <path>] [--interval-ms <N>]\n" +
      "\n" +
      "Tails goal-events.jsonl and emits OTel metrics.\n" +
      "Set GOAL_OTEL_ENDPOINT to a collector URL to push via OTLP/HTTP;\n" +
      "otherwise metrics are printed to stdout in OTLP/JSON form.\n"
  );
}

// ---- stdout exporter ------------------------------------------------------

/**
 * Minimal stdout exporter that prints whatever the SDK gives us in OTLP-shaped
 * JSON (one JSON object per export). Useful for piping into jq / other tools
 * when no collector is configured.
 */
class StdoutMetricExporter implements PushMetricExporter {
  export(
    metrics: unknown,
    resultCallback: (result: { code: number; error?: Error }) => void
  ): void {
    try {
      // The SDK passes a ResourceMetrics-shaped object. We don't depend on
      // its exact type here (different SDK minor versions reshape it slightly),
      // we just JSON-serialize and emit.
      process.stdout.write(
        JSON.stringify({ resourceMetrics: metrics }, replacer) + "\n"
      );
      resultCallback({ code: 0 });
    } catch (e) {
      resultCallback({ code: 1, error: e as Error });
    }
  }

  async shutdown(): Promise<void> {
    // nothing to flush
  }

  async forceFlush(): Promise<void> {
    // nothing to flush
  }
}

function replacer(_key: string, value: unknown): unknown {
  // BigInt → string; hrtime arrays leave as-is.
  if (typeof value === "bigint") return value.toString();
  return value;
}

// ---- meter setup ----------------------------------------------------------

function setupMeterProvider(): { provider: MeterProvider; reader: MetricReader } {
  const endpoint = process.env.GOAL_OTEL_ENDPOINT;
  let exporter: PushMetricExporter;
  let exportIntervalMillis: number;

  if (endpoint && endpoint.length > 0) {
    exporter = new OTLPMetricExporter({ url: endpoint });
    exportIntervalMillis = 10_000;
  } else {
    exporter = new StdoutMetricExporter();
    // For stdout, flush more eagerly so events appear soon after they happen.
    exportIntervalMillis = 1_000;
  }

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return { provider, reader };
}

// Instruments are populated by buildInstruments() AFTER the global meter
// provider is installed. Creating them before that would attach them to the
// no-op default meter and silently drop all records.
interface Instruments {
  counters: {
    created: import("@opentelemetry/api").Counter;
    completed: import("@opentelemetry/api").Counter;
    unmet: import("@opentelemetry/api").Counter;
    budget_limited: import("@opentelemetry/api").Counter;
    relayed: import("@opentelemetry/api").Counter;
    queued: import("@opentelemetry/api").Counter;
  };
  histograms: {
    token_count: import("@opentelemetry/api").Histogram;
    continuation_turns: import("@opentelemetry/api").Histogram;
    elapsed_seconds: import("@opentelemetry/api").Histogram;
    handoff_gap_seconds: import("@opentelemetry/api").Histogram;
    relay_recovery_seconds: import("@opentelemetry/api").Histogram;
  };
}

let inst: Instruments | undefined;

function buildInstruments(): Instruments {
  const meter = metrics.getMeter("goal", "0.2.0");
  return {
    counters: {
      created: meter.createCounter("goal.created", {
        description: "Goals created",
      }),
      completed: meter.createCounter("goal.completed", {
        description: "Goals marked complete by the model",
      }),
      unmet: meter.createCounter("goal.unmet", {
        description: "Goals user-marked as unmet/blocked",
      }),
      budget_limited: meter.createCounter("goal.budget_limited", {
        description: "Goals that hit their token budget",
      }),
      relayed: meter.createCounter("goal.relayed", {
        description: "Goal relay events (agent handoffs) keyed by reason, from, to",
      }),
      queued: meter.createCounter("goal.queued", {
        description: "Goal queued events (all providers throttled) keyed by providers_throttled",
      }),
      lane_conflict: meter.createCounter("goal.lane.conflict", {
        description: "Lane-lease claim attempts denied due to glob conflict with an existing lease",
      }),
    },
    histograms: {
      token_count: meter.createHistogram("goal.token_count", {
        description: "Tokens consumed by a goal, attributed by goal_id",
        unit: "tokens",
        valueType: ValueType.INT,
      }),
      continuation_turns: meter.createHistogram("goal.continuation_turns", {
        description: "Continuation turns until completion",
        unit: "turns",
        valueType: ValueType.INT,
      }),
      elapsed_seconds: meter.createHistogram("goal.elapsed_seconds", {
        description: "Wall-clock seconds elapsed for the goal",
        unit: "s",
        valueType: ValueType.DOUBLE,
      }),
      handoff_gap_seconds: meter.createHistogram("goal.handoff.gap_seconds", {
        description: "Time from handoff envelope write to peer first turn completion",
        unit: "s",
        valueType: ValueType.DOUBLE,
      }),
      relay_recovery_seconds: meter.createHistogram("goal.relay.recovery_seconds", {
        description: "Time from status=relaying to status=pursuing (relay round-trip)",
        unit: "s",
        valueType: ValueType.DOUBLE,
      }),
    },
  };
}

// ---- event dispatch -------------------------------------------------------

interface GoalEvent {
  type?: string;
  goal_id?: string;
  tokens_used?: number;
  continuation_turns?: number;
  elapsed_seconds?: number;
  reason?: string;
  from?: string;
  to?: string;
  providers_throttled?: string;
  handoff_write_ts?: string;
  recovery_seconds?: number;
  [k: string]: unknown;
}

function dispatch(ev: GoalEvent): void {
  if (!inst) return; // dispatched before main() finished wiring instruments
  const attrs = ev.goal_id ? { goal_id: ev.goal_id } : {};
  switch (ev.type) {
    case "goal.created":
      inst.counters.created.add(1, attrs);
      break;
    case "goal.completed":
      inst.counters.completed.add(1, attrs);
      if (typeof ev.elapsed_seconds === "number") {
        inst.histograms.elapsed_seconds.record(ev.elapsed_seconds, attrs);
      }
      if (typeof ev.continuation_turns === "number") {
        inst.histograms.continuation_turns.record(ev.continuation_turns, attrs);
      }
      if (typeof ev.tokens_used === "number") {
        inst.histograms.token_count.record(ev.tokens_used, attrs);
      }
      break;
    case "goal.unmet":
      inst.counters.unmet.add(1, attrs);
      break;
    case "goal.budget_limited":
      inst.counters.budget_limited.add(1, attrs);
      if (typeof ev.tokens_used === "number") {
        inst.histograms.token_count.record(ev.tokens_used, attrs);
      }
      break;
    case "goal.tokens_updated":
      if (typeof ev.tokens_used === "number") {
        inst.histograms.token_count.record(ev.tokens_used, attrs);
      }
      break;
    case "goal.relayed":
      inst.counters.relayed.add(1, {
        ...attrs,
        reason: typeof ev.reason === "string" ? ev.reason : "unknown",
        from:   typeof ev.from   === "string" ? ev.from   : "unknown",
        to:     typeof ev.to     === "string" ? ev.to     : "unknown",
      });
      break;
    case "goal.queued":
      inst.counters.queued.add(1, {
        ...attrs,
        providers_throttled: typeof ev.providers_throttled === "string" ? ev.providers_throttled : "unknown",
      });
      break;
    case "goal.handoff.peer_picked_up":
      if (typeof ev.handoff_write_ts === "string") {
        const gapMs = Date.now() - Date.parse(ev.handoff_write_ts);
        if (Number.isFinite(gapMs) && gapMs >= 0) {
          inst.histograms.handoff_gap_seconds.record(gapMs / 1000, attrs);
        }
      }
      break;
    case "goal.relay.recovery_seconds":
      if (typeof ev.recovery_seconds === "number") {
        inst.histograms.relay_recovery_seconds.record(ev.recovery_seconds, attrs);
      }
      break;
    case "goal.lane.conflict":
      inst.counters.lane_conflict.add(1, attrs);
      break;
    // Unrecognized event types are intentionally ignored.
  }
}

// ---- tail -----------------------------------------------------------------

class Tailer {
  private readonly eventsFile: string;
  private cursorPath: string;
  private buffer = "";
  private offset = 0;
  private running = true;
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(eventsFile: string) {
    this.eventsFile = eventsFile;
    this.cursorPath = path.join(
      path.dirname(eventsFile),
      path.basename(eventsFile).replace(/\.jsonl$/, "") + "-otel-cursor"
    );
  }

  async start(): Promise<void> {
    await this.loadCursor();
    await fsp.mkdir(path.dirname(this.eventsFile), { recursive: true });
    // Ensure the file exists so fs.watch doesn't error.
    if (!fs.existsSync(this.eventsFile)) {
      await fsp.writeFile(this.eventsFile, "", { flag: "a" });
    }
    await this.readNewBytes();
    try {
      this.watcher = fs.watch(this.eventsFile, () => {
        void this.readNewBytes();
      });
    } catch {
      // Fallback below covers watch failure.
    }
    // Belt-and-suspenders poll: fs.watch is unreliable on some filesystems
    // (e.g. Docker bind mounts on macOS).
    this.pollTimer = setInterval(() => {
      void this.readNewBytes();
    }, 1_000);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.saveCursor();
  }

  private async loadCursor(): Promise<void> {
    try {
      const txt = await fsp.readFile(this.cursorPath, "utf8");
      const n = Number(txt.trim());
      if (Number.isFinite(n) && n >= 0) this.offset = n;
    } catch {
      this.offset = 0;
    }
  }

  private async saveCursor(): Promise<void> {
    try {
      const tmp = this.cursorPath + ".tmp";
      await fsp.writeFile(tmp, String(this.offset));
      await fsp.rename(tmp, this.cursorPath);
    } catch {
      // best-effort
    }
  }

  private async readNewBytes(): Promise<void> {
    if (!this.running) return;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.eventsFile);
    } catch {
      return;
    }
    // Handle truncation (file shrunk → reset cursor).
    if (stat.size < this.offset) {
      this.offset = 0;
      this.buffer = "";
    }
    if (stat.size === this.offset) return;
    const stream = fs.createReadStream(this.eventsFile, {
      start: this.offset,
      end: stat.size - 1,
      encoding: "utf8",
    });
    let lastByte = this.offset;
    for await (const chunk of stream) {
      this.buffer += chunk as string;
      lastByte += Buffer.byteLength(chunk as string, "utf8");
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let ev: GoalEvent;
        try {
          ev = JSON.parse(line) as GoalEvent;
        } catch {
          continue;
        }
        try {
          dispatch(ev);
        } catch (e) {
          process.stderr.write(
            `goal-otel-exporter: dispatch error: ${(e as Error).message}\n`
          );
        }
      }
    }
    this.offset = lastByte;
    await this.saveCursor();
  }
}

// ---- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { provider } = setupMeterProvider();
  inst = buildInstruments();

  const tailer = new Tailer(args.events);
  await tailer.start();

  const endpoint = process.env.GOAL_OTEL_ENDPOINT;
  process.stderr.write(
    `goal-otel-exporter: tailing ${args.events}\n` +
      `  endpoint: ${endpoint && endpoint.length > 0 ? endpoint : "(stdout JSON)"}\n`
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`goal-otel-exporter: ${signal} → flushing\n`);
    try {
      await tailer.stop();
      await provider.forceFlush();
      await provider.shutdown();
    } catch (e) {
      process.stderr.write(`shutdown error: ${(e as Error).message}\n`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Keep the process alive (the periodic reader's timer plus our poll timer
  // already do, but be explicit for clarity).
}

main().catch((e) => {
  process.stderr.write(`goal-otel-exporter: fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
