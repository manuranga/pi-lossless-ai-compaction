/**
 * /loss-less-compact: replaces the whole context with one AI-summarized line per message.
 * Every message is also written in full to a file whose number matches its summary line,
 * so the agent can read the original when a summary is not enough.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, ImageContent, Message, Model, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

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
	kept: number;
}

interface Part {
	label: string;
	message: Message;
	wrap?: (text: string) => string;
	/** Index of the projected entry that holds this message. */
	entry: number;
	/** Index of the projected entry to keep from so this message stays whole (a tool result needs its call). */
	cut: number;
}

export default function (pi: ExtensionAPI) {
	let requested: number | undefined;

	pi.registerCommand("loss-less-compact", {
		description: "Compact into per-message AI summaries backed by full-text files; optionally keep the last N messages as they are",
		handler: async (args, ctx) => {
			const keep = args.trim() === "" ? 0 : Number(args.trim());
			if (!Number.isInteger(keep) || keep < 0) {
				ctx.ui.notify("Usage: /loss-less-compact [number of last messages to keep]", "warning");
				return;
			}
			requested = keep;
			await new Promise<void>((resolve) =>
				ctx.compact({
					onComplete: (result) => {
						const { firstId, lastId, clipped, kept } = result.details as Details;
						ctx.ui.notify(`Compacted ${pad(firstId)}-${pad(lastId)}, ${clipped} clipped, ${kept} kept`, clipped > 0 ? "warning" : "info");
						resolve();
					},
					onError: (error) => {
						requested = undefined;
						ctx.ui.notify(`Lossless compaction failed: ${error.message}`, "error");
						resolve();
					},
				}),
			);
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (requested === undefined) return;
		const keep = requested;
		requested = undefined;
		try {
			return { compaction: { ...(await compact(ctx, keep, event.signal)), tokensBefore: event.preparation.tokensBefore } };
		} catch (error) {
			ctx.ui.notify(`Lossless compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { cancel: true };
		}
	});
}

async function compact(ctx: ExtensionContext, keep: number, signal: AbortSignal) {
	const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
	if (!model) throw new Error(`model not found: ${MODEL_PROVIDER}/${MODEL_ID}`);

	const projection = ctx.sessionManager.buildSessionProjection();
	const previous = projection.entries.find((entry) => entry.sourceEntry.type === "compaction")?.sourceEntry;
	const previousSummary = previous?.type === "compaction" ? previous.summary : undefined;
	const firstId = (previous?.type === "compaction" ? ((previous.details as Details | undefined)?.lastId ?? 0) : 0) + 1;
	const parts = toParts(projection.entries);
	const cut = keep > 0 ? parts[parts.length - keep]?.cut : undefined;
	if (keep > parts.length) throw new Error(`cannot keep ${keep} of ${parts.length} messages`);
	const items = toItems(
		cut === undefined ? parts : parts.filter((part) => part.entry < cut),
		firstId,
	);
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
	const footer = `Messages ${pad(firstId)}-${pad(lastId)} are stored in full in ${dir}/, one file per line, named after the line prefix (e.g. ${fileName(items[0])}). The lines above are condensed and leave out exact details. You must look up relevant information there before starting work.`;
	const storyBlock = story ? `\n\n<story>\n${story}\n</story>` : "";
	const carried = story ? previousSummary?.replace(/\n\n<story>[\s\S]*?<\/story>/g, "") : previousSummary;
	const summary = [carried, `${lines.join("\n")}${storyBlock}\n\n${footer}`].filter(Boolean).join("\n\n");
	const details: Details = { firstId, lastId, clipped: missing.length, kept: parts.length - items.length };
	const firstKeptEntryId = cut === undefined ? "" : projection.entries[cut].sourceEntry.id;
	return { summary, firstKeptEntryId, usage, details };
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

function toParts(entries: ProjectedSessionEntry[]): Part[] {
	const calls = new Map<string, { args: unknown; entry: number }>();
	const parts: Part[] = [];
	entries.forEach(({ messages }, entry) => {
		for (const message of convertToLlm(messages.filter((message) => message.role !== "compactionSummary"))) {
			if (message.role === "user" && contentText(message, () => "[image]")) parts.push({ label: "user", message, entry, cut: entry });
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { args: block.arguments, entry });
				if (contentText(message, () => "[image]")) parts.push({ label: "you", message, entry, cut: entry });
			}
			if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				const args = JSON.stringify(call?.args ?? {});
				const error = message.isError ? "ERROR: " : "";
				const wrap = (text: string) => `<args>${args}</args>\n<output>\n${error}${text}\n</output>`;
				parts.push({ label: message.toolName, message, wrap, entry, cut: call?.entry ?? entry });
			}
		}
	});
	return parts;
}

function toItems(parts: Part[], firstId: number): Item[] {
	return parts.map(({ label, message, wrap = (text) => text }, index) => {
		const id = firstId + index;
		const images: Item["images"] = [];
		const text = contentText(message, (image) => {
			const name = `${fileStem({ id, label })}-${images.length + 1}.${image.mimeType.split("/")[1] ?? "bin"}`;
			images.push({ name, data: image.data });
			return `[image: ${name}]`;
		});
		return { id, label, content: wrap(text), images };
	});
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
