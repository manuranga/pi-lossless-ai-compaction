# pi lossless AI compaction

A [pi](https://github.com/earendil-works/pi) extension that adds `/loss-less-compact`. It compacts the whole conversation into one AI-written line per message plus a short `<story>` of the conversation as a whole, and stores every message in full on disk, so nothing is lost: the agent reads the original whenever a summary line is not enough.

```
0004-bash: Ran `bun test tests/auth.test.ts`: 3 pass, 2 fail. "login after reset" got null (auth.test.ts:58) ...
0005-you: Root cause: resetPassword() bumps tokenVersion but leaves the stored session at version 1 ...

<story>
Goal: fix the bug where users are bounced to login after a password reset ...
State: done and committed as a1b2c3d on main ...
</story>

Messages 0001-0011 are stored in full in ~/.full-conversations/<session>-<random>/, one file per line, named after the line prefix (e.g. 0001-user.txt). The lines above are condensed and leave out exact details. You must look up relevant information there before starting work.
```

## Install

```
cp lossless-compact.ts ~/.pi/agent/extensions/
```

Then `/reload` in a running pi. `/compact` and automatic compaction are untouched; only `/loss-less-compact` uses this extension.

## Usage

- `/loss-less-compact` summarizes every message.
- `/loss-less-compact N` keeps the last N message lines as they are, after the summary. A kept tool result also keeps the message that called the tool, so N=1 can keep a few more lines. The next compaction numbers and stores the kept messages.

## Requirements and limits

- The summarizer is always `anthropic/claude-sonnet-5-5`, regardless of the session's model, so Anthropic auth must be configured. Sonnet 5.5 has a 1M-token window; a 573k-token session compacted in one call.
- Pi refuses to compact before any extension runs when the session still fits in `compaction.keepRecentTokens` (default 20k): "Nothing to compact (session too small)".
- A failed summarizer call (network, API error) cancels the compaction and leaves the context unchanged.
- Nothing in `~/.full-conversations/` is ever deleted. Summaries point to absolute paths there, so moving or deleting a directory breaks the summaries that reference it.
- Pi wraps every compaction summary in its own fixed text ("The conversation history before this point was compacted into the following summary:"). An extension cannot change it.

## Measured behaviour

On a real 446-message session (~1.3M chars, 573k tokens):

- Compaction: $1.26, 2m12s, ~48k-char summary (about 28x smaller).
- Recall test: Opus 5.5 continued from the compacted session and answered 10 of 10 questions correctly. The 7 whose answers were not in the summary (exact timings, commit hashes, test results) were each answered by grepping the stored directory and reading one file, at $0.12-0.14 and 9-20 s per question. The 3 answerable from the summary used no tools.
- Of 171 identifiers (hashes, line deltas, file names) checked in summaries, all matched their source message.

The model spends roughly the same output effort per compaction, so compacting fewer messages at a time gives richer lines: 44 messages per compaction produced ~75% more facts per line than 96.

## Why it is built this way

Each choice below was tested on the same session slice (95 summarized messages, 2-4 runs per variant). Run-to-run variation is large (up to ±20% on length), so single runs prove little.

- **One AI call with the whole conversation**, not one call per message: the summarizer sees context across messages. A pi agent given the messages as files instead skimmed them (`head -c 600`) and produced shallow lines.
- **Sonnet 5.5**: Haiku 4.5 attached summaries to the wrong message on long inputs. Sonnet 4.6 was correct but 3x slower. Sonnet 5.5 cannot be forced to call a tool, which is one reason the output is plain text, not a tool call.
- **Pseudo-XML output** (`<s ref="...">`): a malformed element costs one line (it falls back to a clip of the original), while a malformed JSON tool call loses every line. Strict JSON schemas were rejected by Anthropic as too complex beyond ~30 keys.
- **Pseudo-XML input** (`<m ref="...">`, `<args>`, `<output>`): 6% fewer input tokens than JSON (no escaping), same quality.
- **Short messages (≤200 chars) are copied verbatim**, even when the model summarizes them anyway (3-4 of ~41 per run). The model's versions were ~45% shorter and dropped details such as file names and reasons, and turned a user's proposal into a question. The prompt lists the refs to summarize: without the list, or with `summarize="false"` markers, summaries lost ~15% of their facts. A `verbatim="true"` marker matched the list but cost ~3% more.
- **One-line size guidance** ("as long as the message's importance warrants … up to about 600 characters"): a 4-line version with "typical messages: 100-200 characters" capped most lines; replacing it made summaries ~40% richer at the same accuracy.
- **The rules stay**: "keep exact identifiers" carries the facts and the per-role lines carry length and coverage. Removing either, or all rules, made summaries poorer; merging them into one sentence changed nothing.
- **No cross-references between lines**: asking for refs to other messages ("fixes the failure in 0004-bash") either was ignored at scale or produced pointers mostly to the previous line. Refs did not shorten lines or add facts.
- **"you" instead of "assistant"**, with the prompt framed as "a conversation between you and the user": the summary addresses the reader, who continues the work. First person in a summary ("I'll hold M5") means the reader, which is intended. Calling "you" "the agent" in the prompt instead cost ~20% of the facts on tool lines.
- **"Later you will pick up the work from these summaries alone"**: written for a person resuming their own work. An AI-worded version ("these summaries will replace the conversation in your context") thinned the agent's own lines; with no purpose sentence, tool lines lost ~12% of their facts.
- **`<story>` after the lines**: the same call ends with one story of the whole conversation (goal, constraints, done/in progress/blocked, decisions, next steps, critical context, after pi's default compaction prompt), limited to what the lines don't capture. Answering 8 questions from the summary alone, the story won 3 (current state with commit hashes, what happened to the rejected designs, open issues), made 1 more definite, and tied the rest. It adds ~20% to the summary (~4.5k chars on 96 summarized messages) and ~$0.02. It occasionally speculates beyond the messages.
- **No kept tail by default**: everything is summarized and the agent recovers recent detail from the stored files. `/loss-less-compact N` keeps the last N messages for when the latest status matters; in one real session the user pasted the agent's final status back in after compaction had condensed it to one line.
- **A directive footer**: "You must look up relevant information there before starting work." With the earlier footer ("Read a file when you need its full content"), an agent 180 messages after compaction guessed its own email sender address instead of looking it up. Replaying that session's compaction with Opus 5.5: asked for an exact earlier value, every footer led to a lookup (6/6 each). Told only "Continue the work.", the agent read the stored files before anything else in 3/3 runs with this footer, 1/3 with a variant listing what to look up (names, addresses, paths, …), and 0/3 with the earlier footer. Behaviour far from the compaction, where the miss happened, is still unmeasured.
- **Repeated compactions**: earlier blocks' lines and footers are kept byte for byte and numbering continues, so `0012-…` never collides with `0012-…` from an earlier block. Only the newest `<story>` is kept, since it covers the whole conversation and older ones would show a stale state. The previous summary is passed to the summarizer as `<earlier>` context; on the test session this made no measurable difference, but it costs ~1% and helps vague follow-ups.
- **Images** are stored as `NNNN-label-N.<ext>` next to the message text, which names them as `[image: …]`. The summarizer does not see the images.
