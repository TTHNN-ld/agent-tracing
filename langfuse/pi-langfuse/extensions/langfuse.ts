import { createHash, randomUUID } from "node:crypto";
import type {
	AgentMessage,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";

const MAX_IO_CHARS = Number(process.env.LANGFUSE_MAX_IO_CHARS ?? 20000);
const FLUSH_INTERVAL_MS = Number(process.env.LANGFUSE_FLUSH_INTERVAL_MS ?? 1000);
const ENVIRONMENT = process.env.LANGFUSE_ENVIRONMENT ?? "development";

type JsonRecord = Record<string, unknown>;

interface Turn {
	traceId: string;
	sessionId: string;
	sessionFile: string | undefined;
	startTime: number;
	userId: string;
	input: unknown;
	output: unknown;
	model: string | undefined;
	generationId: string | undefined;
}

interface QueuedEvent {
	id: string;
	timestamp: string;
	type: string;
	body: JsonRecord;
}

function now(): string {
	return new Date().toISOString();
}

function iso(time: number | string | undefined): string {
	return new Date(time ?? Date.now()).toISOString();
}

function hash(value: string, length = 32): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableId(...parts: unknown[]): string {
	return hash(parts.map((part) => String(part ?? "")).join(":"));
}

function redact(value: unknown): string {
	const text = (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
	return text
		.replace(/sk-[a-zA-Z0-9_-]{16,}/g, "sk-***")
		.replace(/pk-[a-zA-Z0-9_-]{16,}/g, "pk-***")
		.replace(/(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=***");
}

function clip(value: unknown): unknown {
	if (value == null) return value;
	const text = redact(value);
	if (text.length <= MAX_IO_CHARS) return text;
	return {
		preview: text.slice(0, MAX_IO_CHARS),
		truncated: true,
		originalLength: text.length,
		sha256: hash(text, 64),
	};
}

function authHeader(publicKey: string, secretKey: string): string {
	return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
}

function userId(): string {
	return process.env.LANGFUSE_USER_ID ?? process.env.USER ?? "unknown";
}

function userMetadata(): JsonRecord {
	return {
		id: userId(),
		name: process.env.LANGFUSE_USER_NAME,
		team: process.env.LANGFUSE_TEAM,
	};
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			return `[image:${part.mimeType}]`;
		})
		.join("\n\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return "";
			return `[tool:${part.name}]`;
		})
		.filter(Boolean)
		.join("\n\n");
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

function traceName(input: unknown): string {
	const first = redact(input).replace(/\s+/g, " ").trim().slice(0, 80);
	return first ? `pi.turn: ${first}` : "pi.turn";
}

function usageFromPi(usage: Usage | undefined): JsonRecord | undefined {
	if (!usage) return undefined;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const output = usage.output;
	return {
		input,
		output,
		total: usage.totalTokens || input + output,
		unit: "TOKENS",
		inputCost: usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite,
		outputCost: usage.cost.output,
		totalCost: usage.cost.total,
	};
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function modelName(ctx: ExtensionContext, message?: AssistantMessage): string | undefined {
	if (message) {
		return assistantModelName(message);
	}
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function assistantModelName(message: AssistantMessage): string {
	return [message.provider, message.responseModel ?? message.model].filter(Boolean).join("/");
}

export default function langfuseTracker(pi: ExtensionAPI): void {
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY_PI ?? process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY_PI ?? process.env.LANGFUSE_SECRET_KEY;
	const baseUrl =
		process.env.LANGFUSE_BASEURL_PI ??
		process.env.LANGFUSE_BASE_URL_PI ??
		process.env.LANGFUSE_HOST_PI ??
		process.env.LANGFUSE_BASEURL ??
		process.env.LANGFUSE_BASE_URL ??
		process.env.LANGFUSE_HOST ??
		"https://cloud.langfuse.com";

	if (!publicKey || !secretKey) return;

	const endpoint = `${baseUrl.replace(/\/$/, "")}/api/public/ingestion`;
	const headers = {
		authorization: authHeader(publicKey, secretKey),
		"content-type": "application/json",
	};

	const queue: QueuedEvent[] = [];
	const toolToTurn = new Map<string, Turn>();
	const createdObservations = new Set<string>();
	let activeTurn: Turn | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flushing = false;

	function push(type: string, body: JsonRecord, timestamp = now()): void {
		queue.push({
			id: randomUUID(),
			timestamp,
			type,
			body: { environment: ENVIRONMENT, ...body },
		});
		schedule();
	}

	function schedule(): void {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, FLUSH_INTERVAL_MS);
	}

	async function flush(): Promise<void> {
		if (flushing || queue.length === 0) return;
		flushing = true;
		const batch = queue.splice(0, queue.length);
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ batch }),
			});
			if (!response.ok && response.status !== 207) {
				queue.unshift(...batch);
			}
		} catch {
			queue.unshift(...batch);
		} finally {
			flushing = false;
			if (queue.length) schedule();
		}
	}

	function upsertTrace(turn: Turn): void {
		push("trace-create", {
			id: turn.traceId,
			timestamp: iso(turn.startTime),
			name: traceName(turn.input),
			userId: turn.userId,
			sessionId: turn.sessionId,
			input: clip(turn.input),
			output: clip(turn.output),
			metadata: {
				user: userMetadata(),
				pi: {
					sessionId: turn.sessionId,
					sessionFile: turn.sessionFile,
					model: turn.model,
				},
			},
		});
	}

	function ensureTurn(input: unknown, ctx: ExtensionContext, startTime = Date.now()): Turn {
		if (activeTurn) {
			activeTurn.input = input;
			activeTurn.model = modelName(ctx);
			upsertTrace(activeTurn);
			return activeTurn;
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const traceId = stableId("pi-trace", sessionId, startTime, hash(redact(input), 16));
		activeTurn = {
			traceId,
			sessionId,
			sessionFile,
			startTime,
			userId: userId(),
			input,
			output: "",
			model: modelName(ctx),
			generationId: undefined,
		};
		upsertTrace(activeTurn);
		return activeTurn;
	}

	function currentTurn(ctx: ExtensionContext): Turn {
		return activeTurn ?? ensureTurn("", ctx);
	}

	function upsertGeneration(turn: Turn, message: AssistantMessage, eventType: "generation-create" | "generation-update"): void {
		const generationId = turn.generationId ?? stableId("pi-generation", turn.traceId, message.timestamp);
		turn.generationId = generationId;
		turn.model = assistantModelName(message);
		turn.output = assistantText(message) || {
			stopReason: message.stopReason,
			toolCalls: toolCalls(message).map((toolCall) => ({
				id: toolCall.id,
				name: toolCall.name,
				arguments: toolCall.arguments,
			})),
		};
		upsertTrace(turn);
		push(eventType, {
			id: generationId,
			traceId: turn.traceId,
			name: "llm.call",
			startTime: iso(message.timestamp),
			endTime: eventType === "generation-update" ? now() : undefined,
			model: assistantModelName(message),
			input: clip({
				systemPrompt: "Pi exposes the effective system prompt on before_agent_start; session history is stored in Pi session JSONL.",
				userPrompt: turn.input,
			}),
			output: clip(turn.output),
			usage: usageFromPi(message.usage),
			metadata: {
				user: userMetadata(),
				pi: {
					sessionId: turn.sessionId,
					sessionFile: turn.sessionFile,
					api: message.api,
					provider: message.provider,
					model: message.model,
					responseModel: message.responseModel,
					responseId: message.responseId,
					stopReason: message.stopReason,
					diagnostics: message.diagnostics,
				},
			},
			level: message.stopReason === "error" ? "ERROR" : undefined,
			statusMessage: message.errorMessage,
		});
	}

	function createToolSpan(turn: Turn, event: ToolCallEvent | ToolExecutionStartEvent): void {
		const toolCallId = event.toolCallId;
		toolToTurn.set(toolCallId, turn);
		const observationId = stableId("pi-tool", turn.traceId, toolCallId);
		if (createdObservations.has(observationId)) return;
		createdObservations.add(observationId);
		push("span-create", {
			id: observationId,
			traceId: turn.traceId,
			name: `tool.${event.toolName}`,
			startTime: now(),
			input: clip("input" in event ? event.input : event.args),
			metadata: {
				user: userMetadata(),
				pi: {
					sessionId: turn.sessionId,
					toolCallId,
					toolName: event.toolName,
				},
			},
		});
	}

	function updateToolSpan(event: ToolResultEvent | ToolExecutionEndEvent): void {
		const turn = toolToTurn.get(event.toolCallId) ?? activeTurn;
		if (!turn) return;
		const output = "content" in event ? event.content : event.result;
		const input = "input" in event ? event.input : undefined;
		push("span-update", {
			id: stableId("pi-tool", turn.traceId, event.toolCallId),
			traceId: turn.traceId,
			name: `tool.${event.toolName}`,
			endTime: now(),
			input: clip(input),
			output: clip(output),
			metadata: {
				user: userMetadata(),
				pi: {
					sessionId: turn.sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					details: "details" in event ? event.details : undefined,
				},
			},
			level: event.isError ? "ERROR" : undefined,
		});
	}

	pi.on("before_agent_start", (event, ctx) => {
		const turn = ensureTurn(event.prompt, ctx);
		push("event-create", {
			traceId: turn.traceId,
			name: "pi.before_agent_start",
			startTime: now(),
			input: clip({
				prompt: event.prompt,
				images: event.images?.map((image) => ({ type: image.type, mimeType: image.mimeType })),
				systemPrompt: event.systemPrompt,
				systemPromptOptions: event.systemPromptOptions,
			}),
		});
	});

	pi.on("message_update", (event: MessageUpdateEvent) => {
		if (!activeTurn || event.message.role !== "assistant") return;
		if (event.assistantMessageEvent.type !== "start") return;
		upsertGeneration(activeTurn, event.message, "generation-create");
	});

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		if (event.message.role === "user") {
			ensureTurn(textFromContent(event.message.content), ctx, event.message.timestamp);
			return;
		}
		if (!isAssistantMessage(event.message)) return;
		const turn = currentTurn(ctx);
		upsertGeneration(turn, event.message, "generation-update");
	});

	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		createToolSpan(currentTurn(ctx), event);
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
		createToolSpan(currentTurn(ctx), event);
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		updateToolSpan(event);
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		updateToolSpan(event);
	});

	pi.on("agent_end", async () => {
		activeTurn = undefined;
		await flush();
	});

	pi.on("session_shutdown", async () => {
		await flush();
	});
}
