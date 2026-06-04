import { createHash } from "node:crypto";

const DEFAULT_OTEL_TIMEOUT_MS = 200;

export function hash(value, length = 32) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function stableID(...parts) {
  return hash(parts.map((part) => String(part ?? "")).join(":"));
}

export function toTraceId(id) {
  const value = String(id ?? "");
  return /^[0-9a-f]{32}$/i.test(value) ? value.toLowerCase() : hash(value, 32);
}

export function toSpanId(id) {
  const value = String(id ?? "");
  return /^[0-9a-f]{16}$/i.test(value) ? value.toLowerCase() : hash(value, 16);
}

export function timeUnixNano(value) {
  const date = value ? new Date(value) : new Date();
  return String(BigInt(date.getTime()) * 1000000n);
}

export function stringify(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function attrValue(value) {
  if (value == null) return { stringValue: "" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: stringify(value) ?? "" };
}

export function attrs(record) {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({ key, value: attrValue(value) }));
}

function spanKind(kind) {
  if (kind === "client") return 3;
  if (kind === "server") return 2;
  if (kind === "internal") return 1;
  return 1;
}

function status(level, statusMessage) {
  if (level === "ERROR") {
    return { code: 2, message: statusMessage ?? "error" };
  }
  return { code: 1 };
}

export function langfuseEventToOtelSpan(event, agent) {
  const body = event.body ?? {};
  const traceId = toTraceId(body.traceId ?? body.id);
  const base = {
    traceId,
    spanId: toSpanId(body.id ?? event.id),
    name: body.name ?? event.type,
    kind: spanKind(event.type?.startsWith("generation") ? "client" : "internal"),
    startTimeUnixNano: timeUnixNano(body.startTime ?? body.timestamp ?? event.timestamp),
    endTimeUnixNano: timeUnixNano(body.endTime ?? body.timestamp ?? event.timestamp),
    attributes: attrs({
      "agent.name": agent,
      "langfuse.event.type": event.type,
      "langfuse.environment": body.environment,
      "langfuse.trace.name": body.name,
      "session.id": body.sessionId,
      "user.id": body.userId,
      "input.value": stringify(body.input),
      "output.value": stringify(body.output),
      "langfuse.observation.input": stringify(body.input),
      "langfuse.observation.output": stringify(body.output),
      "langfuse.metadata": stringify(body.metadata),
      "error.message": body.statusMessage,
    }),
    status: status(body.level, body.statusMessage),
  };

  if (event.type === "trace-create") {
    return {
      ...base,
      spanId: toSpanId(`${body.id}:trace`),
      name: body.name ?? `${agent}.turn`,
      kind: spanKind("internal"),
      attributes: attrs({
        "agent.name": agent,
        "langfuse.event.type": event.type,
        "langfuse.environment": body.environment,
        "session.id": body.sessionId,
        "user.id": body.userId,
        "input.value": stringify(body.input),
        "output.value": stringify(body.output),
        "langfuse.observation.input": stringify(body.input),
        "langfuse.observation.output": stringify(body.output),
        "langfuse.metadata": stringify(body.metadata),
      }),
    };
  }

  if (event.type?.startsWith("generation")) {
    return {
      ...base,
      parentSpanId: toSpanId(`${body.traceId}:trace`),
      name: body.name ?? "llm.call",
      kind: spanKind("client"),
      attributes: attrs({
        "agent.name": agent,
        "langfuse.event.type": event.type,
        "langfuse.environment": body.environment,
        "session.id": body.metadata?.sessionId,
        "gen_ai.system": agent,
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": body.model,
        "gen_ai.response.model": body.model,
        "gen_ai.usage.input_tokens": body.usage?.input,
        "gen_ai.usage.output_tokens": body.usage?.output,
        "gen_ai.usage.total_tokens": body.usage?.total,
        "input.value": stringify(body.input),
        "output.value": stringify(body.output),
        "gen_ai.input.messages": stringify(body.input?.messages ?? body.input),
        "gen_ai.output.messages": stringify(body.output),
        "langfuse.observation.input": stringify(body.input),
        "langfuse.observation.output": stringify(body.output),
        "langfuse.metadata": stringify(body.metadata),
        "error.message": body.statusMessage,
      }),
      status: status(body.level, body.statusMessage),
    };
  }

  return {
    ...base,
    parentSpanId: toSpanId(`${body.traceId}:trace`),
    kind: spanKind("internal"),
    attributes: attrs({
      "agent.name": agent,
      "langfuse.event.type": event.type,
      "langfuse.environment": body.environment,
      "session.id": body.metadata?.sessionId,
      "tool.name": String(body.name ?? "").replace(/^tool\./, ""),
      "input.value": stringify(body.input),
      "output.value": stringify(body.output),
      "langfuse.observation.input": stringify(body.input),
      "langfuse.observation.output": stringify(body.output),
      "langfuse.metadata": stringify(body.metadata),
      "error.message": body.statusMessage,
    }),
    status: status(body.level, body.statusMessage),
  };
}

export function otlpPayloadFromEvents(events, { agent, serviceName }) {
  const hasUpdateForSpan = new Set(
    events
      .filter((event) => event.type === "span-update")
      .map((event) => `${event.body?.traceId}:${event.body?.id}`)
  );
  const spans = events
    .filter((event) => {
      if (event.type === "span-create") {
        return !hasUpdateForSpan.has(`${event.body?.traceId}:${event.body?.id}`) && event.body?.output !== undefined;
      }
      if (event.type === "trace-create") {
        const hookEventName = String(event.body?.metadata?.hookEventName ?? "").toLowerCase();
        return event.body?.output !== undefined || hookEventName.includes("stop") || hookEventName.includes("error");
      }
      return event.type === "span-update" || event.type === "generation-create" || event.type === "generation-update";
    })
    .map((event) => langfuseEventToOtelSpan(event, agent));

  if (spans.length === 0) {
    return undefined;
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs({
            "service.name": serviceName ?? `agent-langfuse-${agent}`,
            "deployment.environment": events[0]?.body?.environment,
            "agent.name": agent,
          }),
        },
        scopeSpans: [
          {
            scope: {
              name: "agent-langfuse",
              version: "0.1.0",
            },
            spans,
          },
        ],
      },
    ],
  };
}

export async function postOtlp(payload, endpoint, timeoutMs = DEFAULT_OTEL_TIMEOUT_MS) {
  if (!payload) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint.replace(/\/$/, "") + "/v1/traces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok;
  } finally {
    clearTimeout(timer);
  }
}
