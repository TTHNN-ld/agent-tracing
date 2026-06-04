#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { otlpPayloadFromEvents, postOtlp } from "./otel-utils.mjs";

const AGENT = "codex";
const CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
const MAX_IO_CHARS = Number(process.env.LANGFUSE_MAX_IO_CHARS || 20000);
const ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT || "production";

function now() {
  return new Date().toISOString();
}

function hash(value, length = 32) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function stableID(...parts) {
  return hash(parts.map((part) => String(part ?? "")).join(":"));
}

function debug(message, extra = {}) {
  const path = process.env.LANGFUSE_HOOK_DEBUG_PATH;
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify({ timestamp: now(), agent: AGENT, message, ...extra })}\n`, { flag: "a" });
  } catch {
    // Debug logging must never break notify handling.
  }
}

function redact(value) {
  if (value == null) return value;
  const source = typeof value === "string" ? value : JSON.stringify(value);
  return source
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "sk-***")
    .replace(/pk-[a-zA-Z0-9_-]{16,}/g, "pk-***")
    .replace(/(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=***");
}

function clip(value) {
  if (value == null) return value;
  const source = redact(value);
  if (source.length <= MAX_IO_CHARS) return source;
  return {
    preview: source.slice(0, MAX_IO_CHARS),
    truncated: true,
    originalLength: source.length,
    sha256: hash(source, 64),
  };
}

function textFromContent(content) {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        return item?.text || item?.input_text || item?.output_text || "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return content.text || content.input_text || content.output_text || JSON.stringify(content);
}

function latestSessionFile() {
  const root = join(CODEX_HOME, "sessions");
  let latest;
  function walk(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = statSync(path);
        if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: stat.mtimeMs };
      }
    }
  }
  walk(root);
  return latest?.path;
}

function loadState() {
  const path = join(CODEX_HOME, ".langfuse_codex_notify_state.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { processedTurnIds: [] };
  }
}

function saveState(state) {
  const path = join(CODEX_HOME, ".langfuse_codex_notify_state.json");
  const processedTurnIds = Array.from(new Set(state.processedTurnIds || [])).slice(-200);
  writeFileSync(path, JSON.stringify({ processedTurnIds }, null, 2));
}

function parseLatestTurn(path) {
  const lines = readFileSync(path, "utf8").trim().split(/\n+/).filter(Boolean);
  let session = {};
  const turns = new Map();
  let currentTurnId;

  function turn(id) {
    if (!id) return undefined;
    if (!turns.has(id)) turns.set(id, { turnId: id, steps: [], pendingTools: new Map() });
    return turns.get(id);
  }

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session_meta") {
      session = { ...session, ...record.payload };
      continue;
    }
    if (record.type === "turn_context") {
      currentTurnId = record.payload?.turn_id;
      Object.assign(turn(currentTurnId), {
        cwd: record.payload?.cwd,
        model: record.payload?.model,
      });
      continue;
    }
    const t = turn(currentTurnId);
    if (!t) continue;

    if (record.type === "response_item" && record.payload?.type === "message") {
      const role = record.payload.role;
      const content = textFromContent(record.payload.content);
      if (role === "user" && content) t.input = content;
      if (role === "assistant" && content) {
        t.output = content;
        t.steps.push({
          type: record.payload.phase === "final_answer" ? "assistant.final" : "assistant.message",
          startTime: record.timestamp,
          endTime: record.timestamp,
          output: content,
          metadata: { phase: record.payload.phase },
        });
      }
    }

    if (record.type === "response_item" && record.payload?.type === "function_call") {
      const callId = record.payload.call_id || stableID("function-call", record.timestamp, record.payload.name);
      const step = {
        type: "tool",
        id: callId,
        name: `tool.${record.payload.name || "unknown"}`,
        startTime: record.timestamp,
        input: safeJson(record.payload.arguments),
        metadata: { callId, toolType: "function_call" },
      };
      t.pendingTools.set(callId, step);
      t.steps.push(step);
    }

    if (record.type === "response_item" && record.payload?.type === "function_call_output") {
      const callId = record.payload.call_id;
      const step = t.pendingTools.get(callId);
      if (step) {
        step.endTime = record.timestamp;
        step.output = record.payload.output;
      }
    }

    if (record.type === "response_item" && record.payload?.type === "custom_tool_call") {
      const callId = record.payload.call_id || stableID("custom-tool", record.timestamp, record.payload.name);
      const step = {
        type: "tool",
        id: callId,
        name: `tool.${record.payload.name || "custom"}`,
        startTime: record.timestamp,
        input: record.payload.input,
        metadata: { callId, toolType: "custom_tool_call", status: record.payload.status },
      };
      t.pendingTools.set(callId, step);
      t.steps.push(step);
    }

    if (record.type === "response_item" && record.payload?.type === "custom_tool_call_output") {
      const callId = record.payload.call_id;
      const step = t.pendingTools.get(callId);
      if (step) {
        step.endTime = record.timestamp;
        step.output = safeJson(record.payload.output) ?? record.payload.output;
      }
    }

    if (record.type === "event_msg") {
      const payload = record.payload || {};
      if (payload.type === "user_message" && payload.message) t.input = payload.message;
      if (payload.type === "agent_message" && payload.message) {
        t.output = payload.message;
      }
      if (payload.type === "task_complete") {
        t.completed = true;
        t.completedAt = payload.completed_at ? new Date(payload.completed_at * 1000).toISOString() : record.timestamp;
        t.durationMs = payload.duration_ms;
        if (payload.last_agent_message) t.output = payload.last_agent_message;
      }
      if (payload.type === "token_count" && payload.info?.last_token_usage) {
        const usage = payload.info.last_token_usage;
        t.usage = {
          input: usage.input_tokens,
          output: usage.output_tokens,
          total: usage.total_tokens,
        };
      }
    }
  }

  const completed = Array.from(turns.values()).filter((item) => item.completed);
  const latest = completed.at(-1);
  if (!latest) return undefined;
  return {
    ...latest,
    sessionId: session.id || hash(path, 16),
    cliVersion: session.cli_version,
    originator: session.originator,
    cwd: latest.cwd || session.cwd,
    transcriptPath: path,
  };
}

function safeJson(value) {
  if (value == null || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function traceName(input) {
  const first = String(input || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return first ? `codex.turn: ${first}` : "codex.turn";
}

function assistantInput(turn, steps, index) {
  const messages = [];
  if (turn.input) messages.push({ role: "user", content: turn.input });

  for (const step of steps.slice(0, index)) {
    if (step.type?.startsWith("assistant.") && step.output) {
      messages.push({ role: "assistant", content: step.output });
    } else if (step.type === "tool") {
      messages.push({
        role: "tool",
        name: String(step.name || "tool").replace(/^tool\./, ""),
        input: step.input,
        content: step.output,
      });
    }
  }

  return { messages };
}

async function emitTurn(turn) {
  const traceId = stableID("codex-notify-trace", turn.sessionId, turn.turnId);
  const steps = turn.steps || [];
  const baseMetadata = {
    agent: AGENT,
    hookEventName: "Notify",
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    cwd: turn.cwd,
    model: turn.model,
    cliVersion: turn.cliVersion,
    originator: turn.originator,
    durationMs: turn.durationMs,
    transcriptPath: turn.transcriptPath,
  };
  const events = [{
    id: stableID("codex-notify-event", turn.sessionId, turn.turnId),
    timestamp: turn.completedAt || now(),
    type: "trace-create",
    body: {
      id: traceId,
      timestamp: turn.completedAt || now(),
      name: traceName(turn.input),
      sessionId: turn.sessionId,
      input: clip(turn.input),
      output: clip(turn.output),
      environment: ENVIRONMENT,
      metadata: baseMetadata,
    },
  }];

  for (const [index, step] of steps.entries()) {
    const isAssistant = step.type?.startsWith("assistant.");
    events.push({
      id: stableID("codex-notify-step-event", turn.sessionId, turn.turnId, index),
      timestamp: step.endTime || step.startTime || turn.completedAt || now(),
      type: isAssistant ? "generation-create" : "span-update",
      body: {
        id: stableID("codex-notify-step", turn.sessionId, turn.turnId, index, step.id || step.name),
        traceId,
        name: isAssistant ? "llm.call" : step.name || step.type || "codex.step",
        startTime: step.startTime || turn.completedAt || now(),
        endTime: step.endTime || step.startTime || turn.completedAt || now(),
        model: isAssistant ? turn.model : undefined,
        input: clip(step.input ?? (isAssistant ? assistantInput(turn, steps, index) : undefined)),
        output: clip(step.output),
        usage: isAssistant && step.type === "assistant.final" ? turn.usage : undefined,
        environment: ENVIRONMENT,
        metadata: {
          ...baseMetadata,
          stepType: step.type,
          stepIndex: index,
          ...step.metadata,
        },
      },
    });
  }

  const payload = otlpPayloadFromEvents(events, {
    agent: AGENT,
    serviceName: "agent-langfuse-codex",
  });
  const endpoint = process.env.LANGFUSE_OTEL_ENDPOINT_CODEX || process.env.LANGFUSE_OTEL_ENDPOINT || "http://127.0.0.1:4319";
  const timeoutMs = Number(process.env.LANGFUSE_OTEL_TIMEOUT_MS || 200);
  return postOtlp(payload, endpoint, timeoutMs);
}

function forwardOriginalNotify() {
  if (!process.env.LANGFUSE_CODEX_NOTIFY_FORWARD) return;
  let command;
  try {
    command = JSON.parse(process.env.LANGFUSE_CODEX_NOTIFY_FORWARD);
  } catch {
    return;
  }
  if (!Array.isArray(command) || command.length === 0 || !command[0]) return;
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

try {
  forwardOriginalNotify();
  const path = latestSessionFile();
  if (!path || !existsSync(path)) {
    debug("no session file");
    process.exit(0);
  }
  const latest = parseLatestTurn(path);
  if (!latest?.turnId) {
    debug("no completed turn", { path });
    process.exit(0);
  }
  const state = loadState();
  if (process.env.LANGFUSE_CODEX_NOTIFY_FORCE !== "1" && (state.processedTurnIds || []).includes(latest.turnId)) {
    debug("turn already processed", { turnId: latest.turnId });
    process.exit(0);
  }
  const ok = await emitTurn(latest);
  debug("notify export attempted", { ok, turnId: latest.turnId, sessionId: latest.sessionId });
  state.processedTurnIds = [...(state.processedTurnIds || []), latest.turnId];
  saveState(state);
} catch (error) {
  debug("notify failed", { error: error instanceof Error ? error.stack || error.message : String(error) });
}
