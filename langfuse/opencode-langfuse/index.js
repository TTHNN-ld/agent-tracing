import { createHash, randomUUID } from "crypto"
import { otlpPayloadFromEvents, postOtlp } from "./scripts/otel-utils.mjs"

const MAX_IO_CHARS = Number(process.env.LANGFUSE_MAX_IO_CHARS ?? 20000)
const FLUSH_INTERVAL_MS = Number(process.env.LANGFUSE_FLUSH_INTERVAL_MS ?? 1000)
const ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT ?? "development"

function now() {
  return new Date().toISOString()
}

function iso(time) {
  return new Date(time ?? Date.now()).toISOString()
}

function hash(value, length = 32) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length)
}

function stableID(...parts) {
  return hash(parts.join(":"))
}

function redact(value) {
  if (value == null) return value
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "sk-***")
    .replace(/pk-[a-zA-Z0-9_-]{16,}/g, "pk-***")
    .replace(/(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=***")
}

function clip(value) {
  if (value == null) return value
  const text = redact(value)
  if (text.length <= MAX_IO_CHARS) return text
  return {
    preview: text.slice(0, MAX_IO_CHARS),
    truncated: true,
    originalLength: text.length,
    sha256: hash(text, 64),
  }
}

function partText(parts) {
  return (parts ?? [])
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "file") return [`[file:${part.filename ?? part.mime ?? "attachment"}]`]
      if (part.type === "agent") return [`[agent:${part.name}]`]
      if (part.type === "subtask") return [`[subtask:${part.description || part.agent}]`]
      return []
    })
    .join("\n\n")
}

function traceName(text) {
  const first = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  return first ? `opencode.turn: ${first}` : "opencode.turn"
}

function isSyntheticInput(text, parts) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return false
  if ((parts ?? []).length > 0 && parts.every((part) => part.synthetic || part.ignored)) return true
  return (
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("[BACKGROUND TASK") ||
    trimmed.startsWith("[ALL BACKGROUND TASK") ||
    trimmed.startsWith("Summarize the task tool output above") ||
    trimmed.includes("[BACKGROUND TASK COMPLETED]")
  )
}

function usageFromTokens(tokens) {
  if (!tokens) return undefined
  const input = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0)
  return {
    input,
    output,
    total: tokens.total ?? input + output,
  }
}


function userID() {
  return process.env.LANGFUSE_USER_ID ?? process.env.USER ?? "unknown"
}

function userMetadata() {
  return {
    id: userID(),
    name: process.env.LANGFUSE_USER_NAME,
    team: process.env.LANGFUSE_TEAM,
  }
}

export default {
  id: "local-langfuse-turn-tracker",
  async server({ client }) {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY_OPENCODE
    const secretKey = process.env.LANGFUSE_SECRET_KEY_OPENCODE
    const baseUrl =
      process.env.LANGFUSE_BASEURL_OPENCODE ??
      process.env.LANGFUSE_BASE_URL_OPENCODE ??
      process.env.LANGFUSE_HOST_OPENCODE ??
      "https://cloud.langfuse.com"

    const log = (level, message) =>
      client.app.log({
        body: { service: "langfuse-turn-tracker", level, message },
      })

    if (!publicKey || !secretKey) {
      log("warn", "Missing LANGFUSE_PUBLIC_KEY_OPENCODE or LANGFUSE_SECRET_KEY_OPENCODE - tracing disabled")
      return {}
    }

    const endpoint = process.env.LANGFUSE_OTEL_ENDPOINT_OPENCODE ?? process.env.LANGFUSE_OTEL_ENDPOINT ?? "http://127.0.0.1:4318"
    const timeoutMs = Number(process.env.LANGFUSE_OTEL_TIMEOUT_MS ?? 200)

    const queue = []
    const turns = new Map()
    const currentTurnBySession = new Map()
    const parentSessionBySession = new Map()
    const assistantToTurn = new Map()
    const toolToTurn = new Map()
    const toolCallsByMessage = new Map()
    const generationByMessage = new Map()
    const generationByParentMessage = new Map()
    const textParts = new Map()
    const seenObservations = new Set()
    let timer
    let flushing = false

    function push(type, body, timestamp = now()) {
      queue.push({ id: randomUUID(), timestamp, type, body: { environment: ENVIRONMENT, ...body } })
      schedule()
    }

    function schedule() {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void flush()
      }, FLUSH_INTERVAL_MS)
    }

    async function flush() {
      if (flushing || queue.length === 0) return
      flushing = true
      const batch = queue.splice(0, queue.length)
      try {
        const payload = otlpPayloadFromEvents(batch, {
          agent: "opencode",
          serviceName: "agent-langfuse-opencode",
        })
        const ok = await postOtlp(payload, endpoint, timeoutMs)
        if (!ok) {
          log("warn", `Langfuse OTLP export failed: ${endpoint}`)
        }
      } catch (error) {
        queue.unshift(...batch)
        log("warn", `Langfuse OTLP export failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        flushing = false
        if (queue.length) schedule()
      }
    }

    function ensureTurn(input) {
      const traceID = stableID("trace", input.sessionID, input.messageID)
      let turn = turns.get(input.messageID)
      if (turn) {
        if (input.input && input.input !== turn.input) {
          turn.input = input.input
          updateTrace(turn, {
            name: traceName(turn.input),
            metadata: {
              opencode: {
                sessionID: input.sessionID,
                messageID: input.messageID,
                agent: input.agent,
                model: input.model,
              },
            },
          })
          const generation = generationByParentMessage.get(input.messageID)
          if (generation) upsertGeneration(generation)
        }
        return turn
      }
      turn = {
        traceID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        userID: userID(),
        input: input.input ?? "",
        output: "",
        startTime: input.startTime ?? Date.now(),
      }
      turns.set(input.messageID, turn)
      currentTurnBySession.set(input.sessionID, turn)
      push("trace-create", {
        id: traceID,
        timestamp: iso(turn.startTime),
        name: traceName(turn.input),
        userId: turn.userID,
        sessionId: input.sessionID,
        input: clip(turn.input),
        metadata: {
          user: userMetadata(),
          opencode: {
            sessionID: input.sessionID,
            messageID: input.messageID,
            agent: input.agent,
            model: input.model,
          },
        },
      })
      return turn
    }

    function activeTurn(sessionID) {
      let current = sessionID
      const seen = new Set()
      while (current && !seen.has(current)) {
        seen.add(current)
        const turn = currentTurnBySession.get(current)
        if (turn) {
          currentTurnBySession.set(sessionID, turn)
          return turn
        }
        current = parentSessionBySession.get(current)
      }
    }

    function attachSession(sessionID, turn) {
      if (!sessionID || !turn) return
      currentTurnBySession.set(sessionID, turn)
    }

    function ensureOrAttachTurn(input) {
      const inherited = activeTurn(input.sessionID)
      if (inherited && (input.inherit || isSyntheticInput(input.input, input.parts))) {
        turns.set(input.messageID, inherited)
        attachSession(input.sessionID, inherited)
        push("event-create", {
          traceId: inherited.traceID,
          name: "opencode.synthetic_message",
          startTime: iso(input.startTime),
          input: clip(input.input),
        metadata: {
          user: userMetadata(),
          opencode: {
            sessionID: input.sessionID,
            messageID: input.messageID,
            parentSessionID: parentSessionBySession.get(input.sessionID),
              agent: input.agent,
              model: input.model,
            },
          },
        })
        return inherited
      }
      return ensureTurn(input)
    }

    function updateTrace(turn, patch = {}) {
      push("trace-create", {
        id: turn.traceID,
        timestamp: iso(turn.startTime),
        name: patch.name ?? traceName(turn.input),
        userId: turn.userID,
        sessionId: turn.sessionID,
        input: clip(turn.input),
        output: clip(turn.output),
        metadata: {
          user: userMetadata(),
          opencode: {
            sessionID: turn.sessionID,
            messageID: turn.messageID,
          },
          ...patch.metadata,
        },
        ...patch,
      })
    }

    function generationText(messageID) {
      return Array.from(textParts.entries())
        .filter(([key]) => key.startsWith(`${messageID}:`))
        .map(([, value]) => value)
        .join("")
    }

    function rememberToolCall(part) {
      if (!part?.messageID) return
      const calls = toolCallsByMessage.get(part.messageID) ?? new Map()
      calls.set(part.callID || part.id, {
        callID: part.callID,
        partID: part.id,
        tool: part.tool,
        status: part.state?.status,
        input: part.state?.input,
        title: part.state?.title,
      })
      toolCallsByMessage.set(part.messageID, calls)
    }

    function generationOutput(info, text) {
      if (text) return text
      if (info.structured) return info.structured
      if (info.error) return info.error
      const toolCalls = Array.from(toolCallsByMessage.get(info.id)?.values() ?? [])
      if (toolCalls.length > 0 || info.finish === "tool-calls") {
        return {
          type: "tool-calls",
          finish: info.finish,
          toolCalls,
        }
      }
    }

    function generationInput(info, turn) {
      const messages = []
      if (turn.input) {
        messages.push({
          role: "user",
          content: turn.input,
        })
      }
      return {
        messages,
        note:
          "This is the user-visible turn input captured by the plugin. The full LLM prompt also includes system prompts, history, tool schemas, and tool results, which OpenCode does not expose through the plugin hook.",
        parentMessageID: info.parentID,
        messageID: info.id,
        agent: info.agent,
      }
    }

    function upsertGeneration(info) {
      const turn = assistantToTurn.get(info.id) ?? turns.get(info.parentID) ?? activeTurn(info.sessionID)
      if (!turn) return
      assistantToTurn.set(info.id, turn)
      attachSession(info.sessionID, turn)
      generationByMessage.set(info.id, info)
      if (info.parentID) generationByParentMessage.set(info.parentID, info)
      const observationID = stableID("generation", info.sessionID, info.id)
      const created = seenObservations.has(observationID)
      seenObservations.add(observationID)
      const output = generationText(info.id)
      if (output) {
        turn.output = output
        updateTrace(turn)
      }
      const observedOutput = generationOutput(info, output)
      push(created ? "generation-update" : "generation-create", {
        id: observationID,
        traceId: turn.traceID,
        name: "llm.call",
        startTime: iso(info.time?.created),
        endTime: info.time?.completed ? iso(info.time.completed) : undefined,
        model: [info.providerID, info.modelID].filter(Boolean).join("/"),
        input: clip(generationInput(info, turn)),
        output: clip(observedOutput),
        usage: usageFromTokens(info.tokens),
        metadata: {
          user: userMetadata(),
          opencode: {
            sessionID: info.sessionID,
            messageID: info.id,
            parentID: info.parentID,
            finish: info.finish,
            cost: info.cost,
            error: info.error,
          },
        },
        level: info.error ? "ERROR" : undefined,
        statusMessage: info.error ? JSON.stringify(info.error) : undefined,
      })
    }

    function upsertTool(part) {
      const turn = assistantToTurn.get(part.messageID) ?? toolToTurn.get(part.callID) ?? activeTurn(part.sessionID)
      if (!turn) return
      rememberToolCall(part)
      toolToTurn.set(part.callID, turn)
      attachSession(part.sessionID, turn)
      const observationID = stableID("tool", part.sessionID, part.callID || part.id)
      const created = seenObservations.has(observationID)
      seenObservations.add(observationID)
      const state = part.state ?? {}
      push(created ? "span-update" : "span-create", {
        id: observationID,
        traceId: turn.traceID,
        name: `tool.${part.tool}`,
        startTime: iso(state.time?.start),
        endTime: state.time?.end ? iso(state.time.end) : undefined,
        input: clip(state.input),
        output: clip(state.output ?? state.error ?? state.metadata),
        metadata: {
          user: userMetadata(),
          opencode: {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            callID: part.callID,
            tool: part.tool,
            status: state.status,
            title: state.title,
          },
        },
        level: state.status === "error" ? "ERROR" : undefined,
        statusMessage: state.error,
      })
      const generation = generationByMessage.get(part.messageID)
      if (generation) upsertGeneration(generation)
    }

    return {
      async "chat.message"(input, output) {
        const messageID = output.message?.id ?? input.messageID
        if (!messageID) return
        ensureOrAttachTurn({
          sessionID: input.sessionID,
          messageID,
          input: partText(output.parts),
          parts: output.parts,
          startTime: output.message?.time?.created,
          agent: input.agent,
          model: input.model,
          inherit: parentSessionBySession.has(input.sessionID),
        })
      },
      async "chat.params"(input) {
        const turn = turns.get(input.message?.id) ?? activeTurn(input.sessionID)
        if (!turn) return
        attachSession(input.sessionID, turn)
        updateTrace(turn, {
          metadata: {
            opencode: {
              sessionID: input.sessionID,
              messageID: turn.messageID,
              agent: input.agent,
              model: `${input.model?.providerID}/${input.model?.id ?? input.model?.modelID ?? ""}`,
              provider: input.provider?.id,
            },
          },
        })
      },
      async "tool.execute.before"(input, output) {
        const turn = activeTurn(input.sessionID)
        if (!turn) return
        attachSession(input.sessionID, turn)
        toolToTurn.set(input.callID, turn)
        const observationID = stableID("tool", input.sessionID, input.callID)
        seenObservations.add(observationID)
        push("span-create", {
          id: observationID,
          traceId: turn.traceID,
          name: `tool.${input.tool}`,
          startTime: now(),
          input: clip(output.args),
          metadata: {
            user: userMetadata(),
            opencode: {
              sessionID: input.sessionID,
              callID: input.callID,
              tool: input.tool,
            },
          },
        })
      },
      async "tool.execute.after"(input, output) {
        const turn = toolToTurn.get(input.callID) ?? activeTurn(input.sessionID)
        if (!turn) return
        attachSession(input.sessionID, turn)
        push("span-update", {
          id: stableID("tool", input.sessionID, input.callID),
          traceId: turn.traceID,
          name: `tool.${input.tool}`,
          endTime: now(),
          input: clip(input.args),
          output: clip(output?.output ?? output),
          metadata: {
            user: userMetadata(),
            opencode: {
              sessionID: input.sessionID,
              callID: input.callID,
              tool: input.tool,
              title: output?.title,
              metadata: output?.metadata,
            },
          },
        })
      },
      async "experimental.text.complete"(input, output) {
        const turn = assistantToTurn.get(input.messageID) ?? activeTurn(input.sessionID)
        if (!turn) return
        assistantToTurn.set(input.messageID, turn)
        textParts.set(`${input.messageID}:${input.partID}`, output.text)
        turn.output = generationText(input.messageID)
        updateTrace(turn)
        const generation = generationByMessage.get(input.messageID)
        if (generation) upsertGeneration(generation)
      },
      async event({ event }) {
        if (event.type === "session.created" || event.type === "session.updated") {
          const info = event.properties?.info
          if (info?.parentID) {
            parentSessionBySession.set(info.id ?? event.properties.sessionID, info.parentID)
            const parentTurn = activeTurn(info.parentID)
            if (parentTurn) attachSession(info.id ?? event.properties.sessionID, parentTurn)
          }
        }
        if (event.type === "message.updated") {
          const info = event.properties?.info
          if (info?.role === "user") {
            ensureOrAttachTurn({
              sessionID: event.properties.sessionID,
              messageID: info.id,
              input: "",
              startTime: info.time?.created,
              agent: info.agent,
              model: info.model,
              inherit: parentSessionBySession.has(event.properties.sessionID),
            })
          }
          if (info?.role === "assistant") {
            const turn = turns.get(info.parentID) ?? activeTurn(event.properties.sessionID)
            if (turn) assistantToTurn.set(info.id, turn)
            upsertGeneration(info)
          }
        }
        if (event.type === "message.part.updated") {
          const part = event.properties?.part
          if (part?.type === "tool") upsertTool(part)
          if (part?.type === "text") {
            const turn = assistantToTurn.get(part.messageID) ?? activeTurn(part.sessionID)
            if (!turn) return
            assistantToTurn.set(part.messageID, turn)
            textParts.set(`${part.messageID}:${part.id}`, part.text)
            turn.output = generationText(part.messageID)
            updateTrace(turn)
            const generation = generationByMessage.get(part.messageID)
            if (generation) upsertGeneration(generation)
          }
        }
        if (event.type === "session.idle" || event.type === "server.instance.disposed") {
          await flush()
        }
      },
    }
  },
}
