/**
 * /loss-less-compact: replaces the whole context with one AI-summarized line per message.
 * Every message is also written in full to a file whose number matches its summary line,
 * so the agent can read the original when a summary is not enough.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, ImageContent, Message, Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-5-5";
const VERBATIM_MAX = 200;

interface Item {
	id: number;
	label: string;
	content: string;
	images: { name: string; data: string }[];
}

interface Details {
	firstId: number;
	lastId: number;
	clipped: number;
}

export default function (pi: ExtensionAPI) {
	let requested = false;

	pi.registerCommand("loss-less-compact", {
		description: "Compact everything into per-message AI summaries backed by full-text files",
		handler: async (_args, ctx) => {
			requested = true;
			await new Promise<void>((resolve) =>
				ctx.compact({
					onComplete: (result) => {
						const { firstId, lastId, clipped } = result.details as Details;
						ctx.ui.notify(`Compacted ${pad(firstId)}-${pad(lastId)}, ${clipped} clipped`, clipped > 0 ? "warning" : "info");
						resolve();
					},
					onError: (error) => {
						requested = false;
						ctx.ui.notify(`Lossless compaction failed: ${error.message}`, "error");
						resolve();
					},
				}),
			);
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!requested) return;
		requested = false;
		try {
			return { compaction: { ...(await compact(ctx, event.signal)), tokensBefore: event.preparation.tokensBefore } };
		} catch (error) {
			ctx.ui.notify(`Lossless compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { cancel: true };
		}
	});
}

async function compact(ctx: ExtensionContext, signal: AbortSignal) {
	const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
	if (!model) throw new Error(`model not found: ${MODEL_PROVIDER}/${MODEL_ID}`);

	const projection = ctx.sessionManager.buildSessionProjection();
	const previous = projection.entries.find((entry) => entry.sourceEntry.type === "compaction")?.sourceEntry;
	const previousSummary = previous?.type === "compaction" ? previous.summary : undefined;
	const firstId = (previous?.type === "compaction" ? ((previous.details as Details | undefined)?.lastId ?? 0) : 0) + 1;
	const items = toItems(projection.messages, firstId);
	if (items.length === 0) throw new Error("nothing to compact");

	const root = join(homedir(), ".full-conversations");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, `${ctx.sessionManager.getSessionId()}-`));
	for (const item of items) {
		writeFileSync(join(dir, fileName(item)), item.content);
		for (const image of item.images) writeFileSync(join(dir, image.name), Buffer.from(image.data, "base64"));
	}

	const keys = items.filter(isSummarized).map(fileStem);
	const { summaries, story, usage }: { summaries: Map<string, string>; story?: string; usage?: Usage } =
		keys.length > 0 ? await summarize(ctx, model, items, keys, previousSummary, signal) : { summaries: new Map(), usage: undefined };

	const missing = keys.filter((key) => !summaries.has(key));
	const lines = items.map((item) => {
		const text = isSummarized(item) ? (summaries.get(fileStem(item)) ?? `${oneLine(item.content).slice(0, VERBATIM_MAX)}...`) : item.content;
		return `${fileStem(item)}: ${oneLine(text)}`;
	});
	const lastId = items[items.length - 1].id;
	const footer = `Messages ${pad(firstId)}-${pad(lastId)} are stored in full in ${dir}/, one file per line, named after the line prefix (e.g. ${fileName(items[0])}). Read a file when you need its full content.`;
	const storyBlock = story ? `\n\n<story>\n${story}\n</story>` : "";
	const carried = story ? previousSummary?.replace(/\n\n<story>[\s\S]*?<\/story>/g, "") : previousSummary;
	const summary = [carried, `${lines.join("\n")}${storyBlock}\n\n${footer}`].filter(Boolean).join("\n\n");
	const details: Details = { firstId, lastId, clipped: missing.length };
	return { summary, firstKeptEntryId: "", usage, details };
}

async function summarize(
	ctx: ExtensionContext,
	model: Model<Api>,
	items: Item[],
	keys: string[],
	previousSummary: string | undefined,
	signal: AbortSignal,
) {
	const response = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user", content: buildPrompt(items, keys, previousSummary), timestamp: Date.now() }] },
		{ maxTokens: 64000, cacheRetention: "none", signal },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? response.stopReason);
	const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const summaries = new Map([...text.matchAll(/<s ref="([^"]+)"[^>]*>([\s\S]*?)<\/s>/g)].map((match) => [match[1], match[2]]));
	const story = text.match(/<story>([\s\S]*?)<\/story>/)?.[1].trim();
	return { summaries, story, usage: response.usage };
}

function toItems(messages: Parameters<typeof convertToLlm>[0], firstId: number): Item[] {
	const calls = new Map<string, unknown>();
	const items: Item[] = [];
	const add = (label: string, message: Message, wrap: (text: string) => string = (text) => text) => {
		const id = firstId + items.length;
		const images: Item["images"] = [];
		const text = contentText(message, (image) => {
			const name = `${fileStem({ id, label })}-${images.length + 1}.${image.mimeType.split("/")[1] ?? "bin"}`;
			images.push({ name, data: image.data });
			return `[image: ${name}]`;
		});
		const content = wrap(text);
		if (content) items.push({ id, label, content, images });
	};
	for (const message of convertToLlm(messages.filter((message) => message.role !== "compactionSummary"))) {
		if (message.role === "user") add("user", message);
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block.arguments);
			add("you", message);
		}
		if (message.role === "toolResult") {
			const args = JSON.stringify(calls.get(message.toolCallId) ?? {});
			const error = message.isError ? "ERROR: " : "";
			add(message.toolName, message, (text) => `<args>${args}</args>\n<output>\n${error}${text}\n</output>`);
		}
	}
	return items;
}

function buildPrompt(items: Item[], keys: string[], previousSummary: string | undefined): string {
	const messages = items.map((item) => `<m ref="${fileStem(item)}">\n${item.content}\n</m>`).join("\n");
	const input = previousSummary === undefined ? messages : `<earlier>\n${previousSummary}\n</earlier>\n${messages}`;
	const earlier = previousSummary === undefined ? "" : " <earlier> holds your summaries of the conversation before these messages, for context only.";
	return `Below is a conversation between you and the user, in order, each message in an <m ref="..."> element. Each ref is NNNN-<label>: "user", "you", or the name of a tool you called, with the call arguments as JSON in <args> and the tool output in <output>.${earlier}

Write a one-line summary for each of these refs: ${JSON.stringify(keys)}.

Later you will pick up the work from these summaries alone, so keep what you would need: results, numbers, findings and decisions.

Make each summary as long as the message's importance to the thread warrants: a few words for routine steps, up to about 600 characters for messages that shape the thread.

Rules:
- Keep exact identifiers: file paths, function names, commands, error messages, numbers, commit hashes.
- Tool entries: what was done and what came out (result, key finding, or error).
- Your entries: findings, decisions and their reasons.
- User entries: every request, constraint and preference.
- Terse plain English. Do not repeat the label. Do not invent facts.

After the last element, write a <story> element about the whole conversation, including <earlier> if present: the goal, the user's constraints and preferences, what is done, in progress or blocked, key decisions and why, next steps, and critical context. Include only what the lines above don't capture: what spans several messages, the current state and what comes next. Do not restate what a single line already says.

Output: write one element per ref, in order, exactly as <s ref="<ref>"><summary></s>, then one <story>...</story> element. Write nothing else.

${input}`;
}

function isSummarized(item: Item): boolean {
	return item.content.length > VERBATIM_MAX;
}

function fileName(item: Item): string {
	return `${fileStem(item)}.txt`;
}

function fileStem(item: { id: number; label: string }): string {
	return `${pad(item.id)}-${item.label.replace(/[^\w.-]/g, "_")}`;
}

function pad(id: number): string {
	return String(id).padStart(4, "0");
}

function contentText(message: Message, image: (block: ImageContent) => string): string {
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "image" ? [image(block)] : []))
		.join("\n")
		.trim();
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
