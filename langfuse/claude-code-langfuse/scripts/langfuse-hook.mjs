#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { otlpPayloadFromEvents, postOtlp } from "../../scripts/otel-utils.mjs";

const AGENT = (process.argv[2] || "claudecode").toLowerCase();
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

function isClaudeHumanUser(entry) {
  if (entry?.type !== "user" || entry?.message?.role !== "user") return false;
  const content = entry.message.content;
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "");
}

function claudeMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (part?.type === "text" && typeof part.text === "string") return [part.text];
    return [];
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

function claudeAssistantMessage(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return { role: "assistant", content: [{ type: "text", text: content }] };
  }
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (part?.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (part?.type === "tool_use") {
      return [{
        type: "tool_use",
        id: part.id,
        name: part.name ?? "unknown",
        input: part.input ?? {},
      }];
    }
    return [];
  });
  return parts.length ? { role: "assistant", content: parts } : undefined;
}

function claudeMessageInputText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (part?.type === "text" && typeof part.text === "string") return [part.text];
    if (part?.type === "tool_result") {
      return [`[tool-result:${part.tool_use_id ?? "unknown"}] ${text(part.content) ?? ""}`];
    }
    return [];
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

function usageFromClaude(usage) {
  if (!usage) return undefined;
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return {
    input,
    output,
    total: input + output,
    unit: "TOKENS",
  };
}

function readClaudeTranscript(payload) {
  if (AGENT !== "claudecode") return {};
  const transcriptPath = pick(payload, ["transcript_path", "transcriptPath"]);
  if (!transcriptPath) return {};

  try {
    const entries = readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });

    let latestUserIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (isClaudeHumanUser(entries[index])) {
        latestUserIndex = index;
        break;
      }
    }

    if (latestUserIndex === -1) return {};

    const userEntry = entries[latestUserIndex];
    const userPrompt = claudeMessageText(userEntry.message);
    const assistantEntries = entries
      .slice(latestUserIndex + 1)
      .map((entry, offset) => ({ entry, index: latestUserIndex + 1 + offset }))
      .filter(({ entry }) => entry?.type === "assistant" && entry?.message?.role === "assistant");
    const assistantText = assistantEntries
      .map(({ entry }) => claudeMessageText(entry.message))
      .filter(Boolean)
      .join("\n\n");

    const tools = [];
    const generationByMessage = new Map();
    for (const { entry, index } of assistantEntries) {
      const message = entry.message;
      const messageId = message?.id ?? entry.uuid;
      if (!messageId) continue;
      const generation = generationByMessage.get(messageId) ?? {
        messageId,
        startTime: entry.timestamp,
        endTime: entry.timestamp,
        model: message.model,
        usage: message.usage,
        inputMessages: [{ role: "user", content: userPrompt }],
        outputMessages: [],
      };

      generation.endTime = entry.timestamp ?? generation.endTime;
      generation.model = message.model ?? generation.model;
      generation.usage = message.usage ?? generation.usage;

      const priorToolResults = entries
        .slice(latestUserIndex + 1, index)
        .filter((prior) => prior?.type === "user" && prior?.message?.role === "user")
        .map((prior) => claudeMessageInputText(prior.message))
        .filter(Boolean);
      if (priorToolResults.length) {
        generation.inputMessages = [
          { role: "user", content: userPrompt },
          ...priorToolResults.map((content) => ({ role: "tool", content })),
        ];
      }

      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (part?.type === "tool_use") {
            tools.push({
              id: part.id,
              name: part.name,
              input: part.input,
              startTime: entry.timestamp,
            });
          }
        }
      }

      const output = claudeAssistantMessage(message);
      if (output) generation.outputMessages.push(output);
      generationByMessage.set(messageId, generation);
    }

    let model;
    for (let index = entries.length - 1; index > latestUserIndex; index -= 1) {
      if (entries[index]?.type === "assistant" && entries[index]?.message?.model) {
        model = entries[index].message.model;
        break;
      }
    }

    return {
      turnId: userEntry.uuid ?? userEntry.promptId,
      prompt: userPrompt,
      output: assistantText || undefined,
      model,
      tools,
      generations: Array.from(generationByMessage.values()).map((generation) => ({
        ...generation,
        output: generation.outputMessages.length === 1
          ? generation.outputMessages[0]
          : generation.outputMessages,
      })),
    };
  } catch (error) {
    debug("failed to read claude transcript", {
      transcriptPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClaudeStopTranscript(payload) {
  if (AGENT !== "claudecode") return;
  const eventName = String(pick(payload, ["hook_event_name", "hookName", "eventName", "event", "type"]) ?? "").toLowerCase();
  if (!eventName.includes("stop") && !eventName.includes("sessionend")) return;
  const delayMs = Number(process.env.LANGFUSE_CLAUDE_STOP_DELAY_MS ?? 750);
  if (delayMs > 0) await sleep(delayMs);
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

function toolOutputQuery(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value.query ?? value.input?.query ?? value.result?.query;
  }
  if (typeof value === "string") {
    const match = value.match(/query:\s*"([^"]+)"/i);
    return match?.[1];
  }
  return undefined;
}

function normalize(payload) {
  const eventName = pick(payload, ["hook_event_name", "hookName", "eventName", "event", "type"]) ?? "unknown";
  const transcript = readClaudeTranscript(payload);
  const sessionId =
    pick(payload, ["session_id", "sessionId", "conversation_id", "conversationId"]) ??
    payload.session?.id ??
    hash(pick(payload, ["cwd", "workspace", "transcript_path"]) ?? "unknown-session", 16);
  const prompt = text(pick(payload, ["prompt", "user_prompt", "userPrompt", "message", "input"])) ?? transcript.prompt;
  const output = text(pick(payload, ["last_assistant_message", "assistant_message", "assistantMessage", "response", "output", "result"])) ?? transcript.output;
  const claudePromptTurnId =
    AGENT === "claudecode" && prompt
      ? hash(JSON.stringify(["claude-turn", sessionId, prompt]), 16)
      : undefined;
  const turnId =
    pick(payload, ["turn_id", "turnId", "message_id", "messageId", "prompt_id", "promptId"]) ??
    claudePromptTurnId ??
    transcript.turnId ??
    hash(JSON.stringify([sessionId, pick(payload, ["prompt", "tool_name", "toolName", "last_assistant_message"])]), 16);
  const toolName = pick(payload, ["tool_name", "toolName", "name"]) ?? payload.tool?.name;
  const toolCallId = pick(payload, ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId", "call_id", "callId"]) ?? toolName;
  const toolOutput = pick(payload, ["tool_response", "toolResponse", "tool_output", "toolOutput", "output", "result"]);
  const transcriptTools = transcript.tools ?? [];
  const outputQuery = toolOutputQuery(toolOutput);
  const transcriptTool =
    transcriptTools.find((tool) => tool.id && tool.id === toolCallId) ??
    transcriptTools.find((tool) => tool.name === toolName && outputQuery && tool.input?.query === outputQuery) ??
    transcriptTools.find((tool) => tool.name === toolName);
  const toolInput = pick(payload, ["tool_input", "toolInput", "input", "arguments", "args"]) ?? transcriptTool?.input;
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
    transcriptModel: transcript.model,
    generations: transcript.generations ?? [],
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
    model: pick(payload, ["model", "model_id", "modelId"]) ?? data.transcriptModel,
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
      input: clip(data.prompt),
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
      input: clip(data.prompt),
      output: clip(data.output),
      metadata,
    }));
    for (const generation of data.generations) {
      events.push(event("generation-create", {
        id: stableID(`${AGENT}-generation`, data.traceId, generation.messageId),
        traceId: data.traceId,
        name: "llm.call",
        startTime: generation.startTime ?? now(),
        endTime: generation.endTime ?? now(),
        model: generation.model,
        input: clip({
          messages: generation.inputMessages,
          note:
            "Claude Code hooks expose the user-visible prompt, tool results, and assistant messages. The full provider prompt can also include system prompts, history, and tool schemas that are not exposed to the hook.",
        }),
        output: clip(generation.output),
        usage: usageFromClaude(generation.usage),
        metadata: {
          ...metadata,
          messageId: generation.messageId,
        },
      }));
    }
  }

  return events;
}

try {
  const payload = await readStdin();
  await waitForClaudeStopTranscript(payload);
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
