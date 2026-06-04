#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { otlpPayloadFromEvents, postOtlp } from "./otel-utils.mjs";

const AGENT = (process.argv[2] || "codex").toLowerCase();
const ENV_PREFIX = AGENT === "claudecode" ? "CLAUDECODE" : "CODEX";
const MAX_IO_CHARS = Number(process.env.LANGFUSE_MAX_IO_CHARS ?? 20000);
const ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT ?? "production";

function debug(message, extra = {}) {
  const path = process.env.LANGFUSE_HOOK_DEBUG_PATH;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ timestamp: now(), agent: AGENT, message, ...extra })}\n`);
  } catch {
    // Debug logging must never break hook execution.
  }
}

function now() {
  return new Date().toISOString();
}

function hash(value, length = 32) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function stableID(...parts) {
  return hash(parts.map((part) => String(part ?? "")).join(":"));
}

function pick(obj, names) {
  for (const name of names) {
    const value = obj?.[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function text(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return text(value.content);
  }
  return JSON.stringify(value);
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

function authHeader(publicKey, secretKey) {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

function traceName(agent, prompt) {
  const first = String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return first ? `${agent}.turn: ${first}` : `${agent}.turn`;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

async function ingest(events) {
  const publicKey = process.env[`LANGFUSE_PUBLIC_KEY_${ENV_PREFIX}`];
  const secretKey = process.env[`LANGFUSE_SECRET_KEY_${ENV_PREFIX}`];
  const baseUrl =
    process.env[`LANGFUSE_BASEURL_${ENV_PREFIX}`] ??
    process.env[`LANGFUSE_BASE_URL_${ENV_PREFIX}`] ??
    process.env[`LANGFUSE_HOST_${ENV_PREFIX}`] ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    debug("missing credentials", { envPrefix: ENV_PREFIX });
    console.warn(`[langfuse-hook] missing LANGFUSE_PUBLIC_KEY_${ENV_PREFIX} or LANGFUSE_SECRET_KEY_${ENV_PREFIX}`);
    return;
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/public/ingestion`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: authHeader(publicKey, secretKey),
      "content-type": "application/json",
    },
    body: JSON.stringify({ batch: events }),
  });

  if (!response.ok && response.status !== 207) {
    const body = await response.text();
    debug("ingestion returned non-ok", { status: response.status, body });
    console.warn(`[langfuse-hook] Langfuse ingestion returned ${response.status}: ${body}`);
  } else {
    debug("ingestion ok", { status: response.status, count: events.length });
  }
}

function otelEndpoint() {
  return (
    process.env[`LANGFUSE_OTEL_ENDPOINT_${ENV_PREFIX}`] ??
    process.env.LANGFUSE_OTEL_ENDPOINT ??
    (ENV_PREFIX === "CLAUDECODE" ? "http://127.0.0.1:4318" : "http://127.0.0.1:4319")
  );
}

async function emitEvents(events) {
  if (!events.length) return;
  const transport = (process.env.LANGFUSE_TRANSPORT ?? "otel").toLowerCase();
  if (transport !== "otel") {
    await ingest(events);
    return;
  }

  const payload = otlpPayloadFromEvents(events, {
    agent: AGENT,
    serviceName: `agent-langfuse-${AGENT}`,
  });
  const timeoutMs = Number(process.env.LANGFUSE_OTEL_TIMEOUT_MS ?? 200);
  try {
    const ok = await postOtlp(payload, otelEndpoint(), timeoutMs);
    debug("otel export attempted", { ok, endpoint: otelEndpoint(), count: events.length });
    if (!ok && process.env.LANGFUSE_OTEL_FALLBACK_INGESTION === "1") {
      await ingest(events);
    }
  } catch (error) {
    debug("otel export failed", {
      endpoint: otelEndpoint(),
      error: error instanceof Error ? error.message : String(error),
    });
    if (process.env.LANGFUSE_OTEL_FALLBACK_INGESTION === "1") {
      await ingest(events);
    }
  }
}

function event(type, body) {
  return {
    id: randomUUID(),
    timestamp: now(),
    type,
    body: { environment: ENVIRONMENT, ...body },
  };
}

function normalize(payload) {
  const eventName = pick(payload, ["hook_event_name", "hookName", "eventName", "event", "type"]) ?? "unknown";
  const sessionId =
    pick(payload, ["session_id", "sessionId", "conversation_id", "conversationId"]) ??
    payload.session?.id ??
    hash(pick(payload, ["cwd", "workspace", "transcript_path"]) ?? "unknown-session", 16);
  const turnId =
    pick(payload, ["turn_id", "turnId", "message_id", "messageId", "prompt_id", "promptId"]) ??
    hash(JSON.stringify([sessionId, pick(payload, ["prompt", "tool_name", "toolName", "last_assistant_message"])]), 16);
  const prompt = text(pick(payload, ["prompt", "user_prompt", "userPrompt", "message", "input"]));
  const output = text(pick(payload, ["last_assistant_message", "assistant_message", "assistantMessage", "response", "output", "result"]));
  const toolName = pick(payload, ["tool_name", "toolName", "name"]) ?? payload.tool?.name;
  const toolCallId = pick(payload, ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId", "call_id", "callId"]) ?? toolName;
  const toolInput = pick(payload, ["tool_input", "toolInput", "input", "arguments", "args"]);
  const toolOutput = pick(payload, ["tool_response", "toolResponse", "tool_output", "toolOutput", "output", "result"]);
  const traceId = stableID(`${AGENT}-trace`, sessionId, turnId);
  const observationId = stableID(`${AGENT}-tool`, traceId, toolCallId);

  return {
    eventName: String(eventName),
    sessionId: String(sessionId),
    turnId: String(turnId),
    traceId,
    observationId,
    prompt,
    output,
    toolName: toolName ? String(toolName) : undefined,
    toolInput,
    toolOutput,
  };
}

function buildEvents(payload) {
  const data = normalize(payload);
  const metadata = {
    agent: AGENT,
    hookEventName: data.eventName,
    sessionId: data.sessionId,
    turnId: data.turnId,
    cwd: pick(payload, ["cwd", "workspace", "workspaceRoot"]),
    model: pick(payload, ["model", "model_id", "modelId"]),
    transcriptPath: pick(payload, ["transcript_path", "transcriptPath"]),
  };
  const events = [];
  const lower = data.eventName.toLowerCase();

  if (lower.includes("userprompt") || lower === "prompt_submit") {
    events.push(event("trace-create", {
      id: data.traceId,
      timestamp: now(),
      name: traceName(AGENT, data.prompt),
      userId: process.env.LANGFUSE_USER_ID ?? process.env.USER ?? "unknown",
      sessionId: data.sessionId,
      input: clip(data.prompt),
      metadata,
    }));
  } else if (lower.includes("pretool")) {
    events.push(event("span-create", {
      id: data.observationId,
      traceId: data.traceId,
      name: `tool.${data.toolName ?? "unknown"}`,
      startTime: now(),
      input: clip(data.toolInput),
      metadata,
    }));
  } else if (lower.includes("posttool")) {
    events.push(event("span-create", {
      id: data.observationId,
      traceId: data.traceId,
      name: `tool.${data.toolName ?? "unknown"}`,
      startTime: now(),
      input: clip(data.toolInput),
      metadata,
    }));
    events.push(event("span-update", {
      id: data.observationId,
      traceId: data.traceId,
      name: `tool.${data.toolName ?? "unknown"}`,
      endTime: now(),
      input: clip(data.toolInput),
      output: clip(data.toolOutput),
      metadata,
      level: payload.error ? "ERROR" : undefined,
      statusMessage: payload.error ? text(payload.error) : undefined,
    }));
  } else if (lower.includes("stopfailure") || lower.includes("error")) {
    events.push(event("trace-create", {
      id: data.traceId,
      timestamp: now(),
      name: traceName(AGENT, data.prompt),
      sessionId: data.sessionId,
      output: clip(data.output),
      metadata,
      level: "ERROR",
      statusMessage: text(payload.error ?? data.output ?? "run failed"),
    }));
  } else if (lower.includes("stop") || lower.includes("sessionend")) {
    events.push(event("trace-create", {
      id: data.traceId,
      timestamp: now(),
      name: traceName(AGENT, data.prompt),
      sessionId: data.sessionId,
      output: clip(data.output),
      metadata,
    }));
  }

  return events;
}

try {
  const payload = await readStdin();
  const events = buildEvents(payload);
  debug("hook invoked", {
    hookEventName: pick(payload, ["hook_event_name", "hookName", "eventName", "event", "type"]),
    eventCount: events.length,
    hasPublicKey: Boolean(process.env[`LANGFUSE_PUBLIC_KEY_${ENV_PREFIX}`]),
    hasSecretKey: Boolean(process.env[`LANGFUSE_SECRET_KEY_${ENV_PREFIX}`]),
  });
  await emitEvents(events);
} catch (error) {
  debug("hook failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.warn(`[langfuse-hook] ${error instanceof Error ? error.message : String(error)}`);
}
