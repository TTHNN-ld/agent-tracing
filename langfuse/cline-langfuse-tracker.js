import { createHash, randomUUID } from "node:crypto"

const MAX_IO_CHARS = Number(process.env.LANGFUSE_MAX_IO_CHARS ?? 20000)
const FLUSH_INTERVAL_MS = Number(process.env.LANGFUSE_FLUSH_INTERVAL_MS ?? 1000)
const ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT ?? process.env.CLINE_ENVIRONMENT ?? "development"

function now() {
	return new Date().toISOString()
}

function iso(value) {
	return new Date(value ?? Date.now()).toISOString()
}

function hash(value, length = 32) {
	return createHash("sha256").update(String(value)).digest("hex").slice(0, length)
}

function stableID(...parts) {
	return hash(parts.join(":"))
}

function authHeader(publicKey, secretKey) {
	return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`
}

function userID() {
	return process.env.LANGFUSE_USER_ID ?? process.env.USER ?? "unknown"
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

function asObject(value) {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value
	}
	return undefined
}

function decodeXmlEntities(text) {
	return String(text ?? "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
}

function unwrapClineUserInput(text) {
	const source = String(text ?? "").replace(/^\uFEFF/, "").trim()
	const match = source.match(/^<user[_-]input\b([^>]*)>([\s\S]*)<\/user[_-]input>$/i)
	if (!match) {
		return { text: source }
	}
	const attrs = match[1] ?? ""
	const mode = attrs.match(/\bmode=["']([^"']+)["']/)?.[1]
	return {
		text: decodeXmlEntities(match[2] ?? "").trim(),
		mode,
	}
}

function cleanClineDisplayText(text) {
	return unwrapClineUserInput(text).text
}

function displayTextForMessage(message, text) {
	if (message?.role !== "user") return text ?? ""
	return cleanClineDisplayText(text)
}

function userInputInfo(message) {
	if (message?.role !== "user") return {}
	const parts = Array.isArray(message?.content) ? message.content : []
	const textPart = parts.find((part) => part?.type === "text")
	return unwrapClineUserInput(textPart?.text)
}

function messageText(message) {
	const parts = Array.isArray(message?.content) ? message.content : []
	return parts
		.flatMap((part) => {
			if (part?.type === "text") return [displayTextForMessage(message, part.text)]
			if (part?.type === "reasoning") return [`[reasoning:${part.redacted ? "redacted" : "visible"}]`]
			if (part?.type === "file") return [`[file:${part.path ?? "attachment"}]`]
			if (part?.type === "image") return [`[image:${part.mediaType ?? "unknown"}]`]
			if (part?.type === "tool-call") return [`[tool:${part.toolName}] ${JSON.stringify(part.input ?? {})}`]
			if (part?.type === "tool-result") return [`[tool-result:${part.toolName}] ${JSON.stringify(part.output ?? {})}`]
			return []
		})
		.join("\n\n")
}

function serializeMessage(message) {
	return {
		id: message?.id,
		role: message?.role,
		createdAt: message?.createdAt,
		modelInfo: message?.modelInfo,
		metrics: message?.metrics,
		content: Array.isArray(message?.content)
			? message.content.map((part) => {
					if (part?.type === "image") {
						return { type: "image", mediaType: part.mediaType }
					}
					if (part?.type === "text") {
						return { ...part, text: displayTextForMessage(message, part.text) }
					}
					return part
				})
			: [],
	}
}

function traceName(text) {
	const first = cleanClineDisplayText(text)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
	return first ? `cline.run: ${first}` : "cline.run"
}

function usageFromMetrics(metrics) {
	if (!metrics) return undefined
	const input = (metrics.inputTokens ?? 0) + (metrics.cacheReadTokens ?? 0) + (metrics.cacheWriteTokens ?? 0)
	const output = metrics.outputTokens ?? 0
	return {
		input,
		output,
		total: input + output,
	}
}

function usageFromRun(usage) {
	if (!usage) return undefined
	const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
	const output = usage.outputTokens ?? 0
	return {
		input,
		output,
		total: input + output,
	}
}

function loggerFrom(ctx) {
	const logger = ctx?.logger
	const call = (level, message, extra) => {
		const formatted = `[langfuse-tracker] ${message}`
		if (logger?.[level]) logger[level](formatted, extra)
		else if (logger?.log) logger.log(formatted, extra)
		else if (level === "error") console.error(formatted, extra ?? "")
		else if (level === "warn") console.warn(formatted, extra ?? "")
		else console.log(formatted, extra ?? "")
	}
	return {
		info: (message, extra) => call("info", message, extra),
		warn: (message, extra) => call("warn", message, extra),
		error: (message, extra) => call("error", message, extra),
	}
}

function createLangfuseClient(ctx) {
	const log = loggerFrom(ctx)
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY_CLINE
	const secretKey = process.env.LANGFUSE_SECRET_KEY_CLINE
	const baseUrl =
		process.env.LANGFUSE_BASEURL_CLINE ??
		process.env.LANGFUSE_BASE_URL_CLINE ??
		process.env.LANGFUSE_HOST_CLINE ??
		"https://cloud.langfuse.com"

	if (!publicKey || !secretKey) {
		log.warn("Missing LANGFUSE_PUBLIC_KEY_CLINE or LANGFUSE_SECRET_KEY_CLINE - tracing disabled")
		return undefined
	}

	const endpoint = `${baseUrl.replace(/\/$/, "")}/api/public/ingestion`
	const queue = []
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
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					authorization: authHeader(publicKey, secretKey),
					"content-type": "application/json",
				},
				body: JSON.stringify({ batch }),
			})
			if (!response.ok && response.status !== 207) {
				log.warn(`Langfuse ingestion returned ${response.status}: ${await response.text()}`)
			}
		} catch (error) {
			queue.unshift(...batch)
			log.warn(`Langfuse ingestion failed: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			flushing = false
			if (queue.length) schedule()
		}
	}

	return { push, flush, log }
}

function createRunTracker(ctx, client) {
	const runs = new Map()
	const toolStarts = new Map()
	const workspaceInfo = ctx?.workspaceInfo
	const user = ctx?.user

	function runKey(snapshot) {
		return snapshot?.runId ?? snapshot?.conversationId ?? snapshot?.agentId ?? "unknown"
	}

	function ensureRun(snapshot) {
		const key = runKey(snapshot)
		let run = runs.get(key)
		if (run) return run

		const traceID = stableID("cline-trace", snapshot?.conversationId ?? "", key, snapshot?.agentId ?? "")
		run = {
			key,
			traceID,
			startTime: Date.now(),
			input: "",
			output: "",
			generations: new Set(),
		}
		runs.set(key, run)
		client.push("trace-create", {
			id: traceID,
			timestamp: iso(run.startTime),
			name: "cline.run",
			userId: user?.id ?? userID(),
			sessionId: snapshot?.conversationId ?? key,
			metadata: {
				user: {
					id: user?.id ?? userID(),
					name: user?.displayName ?? process.env.LANGFUSE_USER_NAME,
					team: process.env.LANGFUSE_TEAM,
				},
				cline: {
					agentId: snapshot?.agentId,
					agentRole: snapshot?.agentRole,
					parentAgentId: snapshot?.parentAgentId,
					conversationId: snapshot?.conversationId,
					runId: snapshot?.runId,
				},
				workspace: {
					rootPath: workspaceInfo?.rootPath,
					branch: workspaceInfo?.latestGitBranchName,
					commit: workspaceInfo?.latestGitCommitHash,
				},
			},
		})
		return run
	}

	function updateTrace(run, patch = {}) {
		client.push("trace-create", {
			id: run.traceID,
			timestamp: iso(run.startTime),
			name: patch.name ?? traceName(run.input),
			userId: user?.id ?? userID(),
			sessionId: patch.sessionId ?? run.key,
			input: clip(cleanClineDisplayText(run.input)),
			output: clip(run.output),
			...patch,
			...(patch.input === undefined ? {} : { input: clip(cleanClineDisplayText(patch.input)) }),
		})
	}

	function beforeRun({ snapshot }) {
		ensureRun(snapshot)
	}

	function beforeModel({ snapshot, request }) {
		const run = ensureRun(snapshot)
		const lastUser = [...(request?.messages ?? [])].reverse().find((message) => message.role === "user")
		const inputInfo = userInputInfo(lastUser)
		run.input = messageText(lastUser) || run.input
		updateTrace(run, {
			name: traceName(run.input),
			sessionId: snapshot?.conversationId ?? run.key,
			metadata: {
				cline: {
					agentId: snapshot?.agentId,
					agentRole: snapshot?.agentRole,
					conversationId: snapshot?.conversationId,
					runId: snapshot?.runId,
					iteration: snapshot?.iteration,
					mode: inputInfo.mode,
				},
			},
		})

		const generationID = stableID("cline-generation", run.traceID, snapshot?.iteration ?? 0)
		run.generations.add(generationID)
		client.push("generation-create", {
			id: generationID,
			traceId: run.traceID,
			name: "llm.call",
			startTime: now(),
			input: clip({
				systemPrompt: request?.systemPrompt,
				messages: (request?.messages ?? []).map(serializeMessage),
				tools: request?.tools,
				options: request?.options,
			}),
			metadata: {
				cline: {
					iteration: snapshot?.iteration,
					agentId: snapshot?.agentId,
					agentRole: snapshot?.agentRole,
					conversationId: snapshot?.conversationId,
					runId: snapshot?.runId,
					mode: inputInfo.mode,
				},
			},
		})
	}

	function afterModel({ snapshot, assistantMessage, finishReason }) {
		const run = ensureRun(snapshot)
		const generationID = stableID("cline-generation", run.traceID, snapshot?.iteration ?? 0)
		const output = messageText(assistantMessage)
		run.output = output || run.output
		updateTrace(run, { name: traceName(run.input), sessionId: snapshot?.conversationId ?? run.key })
		client.push("generation-update", {
			id: generationID,
			traceId: run.traceID,
			name: "llm.call",
			endTime: now(),
			model: [assistantMessage?.modelInfo?.provider, assistantMessage?.modelInfo?.id].filter(Boolean).join("/"),
			output: clip(serializeMessage(assistantMessage)),
			usage: usageFromMetrics(assistantMessage?.metrics),
			metadata: {
				cline: {
					iteration: snapshot?.iteration,
					finishReason,
					messageId: assistantMessage?.id,
					modelInfo: assistantMessage?.modelInfo,
					metrics: assistantMessage?.metrics,
				},
			},
			level: finishReason === "error" ? "ERROR" : undefined,
			statusMessage: finishReason === "error" ? snapshot?.lastError : undefined,
		})
	}

	function beforeTool({ snapshot, tool, toolCall, input }) {
		const run = ensureRun(snapshot)
		const observationID = stableID("cline-tool", run.traceID, toolCall?.toolCallId ?? toolCall?.toolName)
		toolStarts.set(observationID, Date.now())
		client.push("span-create", {
			id: observationID,
			traceId: run.traceID,
			name: `tool.${toolCall?.toolName ?? tool?.name ?? "unknown"}`,
			startTime: now(),
			input: clip(input),
			metadata: {
				cline: {
					iteration: snapshot?.iteration,
					toolCallId: toolCall?.toolCallId,
					toolName: toolCall?.toolName,
					toolDescription: tool?.description,
				},
			},
		})
	}

	function afterTool({ snapshot, tool, toolCall, input, result, startedAt, endedAt, durationMs }) {
		const run = ensureRun(snapshot)
		const observationID = stableID("cline-tool", run.traceID, toolCall?.toolCallId ?? toolCall?.toolName)
		const started = startedAt ?? toolStarts.get(observationID)
		client.push("span-update", {
			id: observationID,
			traceId: run.traceID,
			name: `tool.${toolCall?.toolName ?? tool?.name ?? "unknown"}`,
			startTime: started ? iso(started) : undefined,
			endTime: endedAt ? iso(endedAt) : now(),
			input: clip(input),
			output: clip(result?.output),
			metadata: {
				cline: {
					iteration: snapshot?.iteration,
					toolCallId: toolCall?.toolCallId,
					toolName: toolCall?.toolName,
					isError: result?.isError,
					durationMs,
				},
			},
			level: result?.isError ? "ERROR" : undefined,
			statusMessage: result?.isError ? JSON.stringify(asObject(result?.output)?.error ?? result?.output) : undefined,
		})
	}

	async function afterRun({ snapshot, result }) {
		const run = ensureRun(snapshot)
		run.output = result?.outputText || run.output
		updateTrace(run, {
			name: traceName(run.input),
			sessionId: snapshot?.conversationId ?? run.key,
			output: clip(run.output),
			metadata: {
				cline: {
					status: result?.status,
					iterations: result?.iterations,
					agentId: result?.agentId,
					agentRole: result?.agentRole,
					runId: result?.runId,
					usage: result?.usage,
					error: result?.error?.message,
				},
			},
			usage: usageFromRun(result?.usage),
			level: result?.status === "failed" ? "ERROR" : undefined,
			statusMessage: result?.error?.message,
		})
		await client.flush()
	}

	async function onEvent(event) {
		if (event?.type !== "run-failed") return
		const run = ensureRun(event.snapshot)
		updateTrace(run, {
			level: "ERROR",
			statusMessage: event.error?.message ?? String(event.error ?? "run failed"),
		})
		await client.flush()
	}

	return {
		hooks: {
			beforeRun,
			beforeModel,
			afterModel,
			beforeTool,
			afterTool,
			afterRun,
			onEvent,
		},
	}
}

let activeTracker

export default {
	name: "langfuse-tracker",
	manifest: {
		capabilities: ["hooks"],
	},
	setup(_api, ctx) {
		const client = createLangfuseClient(ctx)
		if (!client) return {}
		client.log.info("enabled")
		activeTracker = createRunTracker(ctx, client)
		process.once("beforeExit", () => {
			void client.flush()
		})
		return { hooks: activeTracker.hooks }
	},
	hooks: {
		beforeRun(context) {
			return activeTracker?.hooks.beforeRun(context)
		},
		beforeModel(context) {
			return activeTracker?.hooks.beforeModel(context)
		},
		afterModel(context) {
			return activeTracker?.hooks.afterModel(context)
		},
		beforeTool(context) {
			return activeTracker?.hooks.beforeTool(context)
		},
		afterTool(context) {
			return activeTracker?.hooks.afterTool(context)
		},
		afterRun(context) {
			return activeTracker?.hooks.afterRun(context)
		},
		onEvent(event) {
			return activeTracker?.hooks.onEvent(event)
		},
	},
}
