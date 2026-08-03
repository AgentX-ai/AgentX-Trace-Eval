---
name: improve-prompt
description: Propose an improved version of a prompt registered in a self-hosted AgentX (AgentX-trace-eval) instance, using real low-rated evaluation results as evidence, then publish it as a new version once the user explicitly approves. Use when the user asks to improve, tune, optimize, or "autotune" a prompt tracked in AgentX self-host.
---

# Improve an AgentX self-host prompt

AgentX self-host has no access to the agent you're improving — it only stores versioned prompt
text your own code pulls at runtime (`client.evaluations.prompts.get(name)`) and the eval results
you tag with that prompt's name. This skill is the Claude-Code-native way to close the loop: read
the real evidence from the engine, reason about a rewrite yourself (no separate judge API key
needed), show the user the diff, and only write a new version back once they say yes. Never
publish without an explicit approval in this same conversation — that is the one hard rule here.

**Every command below shows `<API_KEY>`, `<BASE_URL>`, `<PROMPT_ID>` as placeholders, not shell
variables.** Bash tool calls in this environment do not share shell state with each other — a
variable exported in one call is gone by the next. Read each value once (steps 1–2), keep it in
your own context, and substitute the literal value into every command that needs it from then on.
Do not write `export API_KEY=...` and expect it to survive into a later, separate command.

## 1. Discover the engine

```bash
cat "${AGENTX_HOME:-$HOME/.agentx}/config.json"
```

This returns `{"apiKey": "agtx_local_..."}`. If the file doesn't exist, the engine has never been
started on this machine — tell the user to run `agentx-server --dev` (or their equivalent) first,
and stop here.

```bash
echo "${AGENTX_API_BASE_URL:-http://localhost:4700/api/v1}"
```

This one's safe to run as a real lookup (unlike a variable Claude itself would try to set) since
it reads the user's actual process environment, which every fresh Bash call inherits regardless of
what earlier calls did. The result is `<BASE_URL>` — `http://localhost:4700/api/v1` unless the user
already pointed their SDK somewhere non-default, in which case this reuses that same setting.

Every request below sends header `x-api-key: <API_KEY>` using the value you just read.

## 2. Resolve which prompt

```bash
curl -s "<BASE_URL>/evaluate/prompts" -H "x-api-key: <API_KEY>"
```

Returns `{"prompts": [{"_id": "...", "name": "...", "currentVersion": 2, ...}, ...]}`. If the user
named a prompt, match it by `name` (case-insensitive is fine) and remember its `_id` as
`<PROMPT_ID>` for every step below. If they didn't name one, or nothing matches, show them the
list and ask which one they mean before continuing.

## 3. Fetch real evidence — no judge call

```bash
curl -s "<BASE_URL>/evaluate/prompts/<PROMPT_ID>/examples" -H "x-api-key: <API_KEY>"
```

Optional query params: `?datasetId=<id>` scopes the eval-run half to one dataset;
`?window=24h|7d|30d` (default `7d`) scopes the Online Evaluator half to a recent time window;
`?includeAllVersions=true` skips the default current-version-only filter on eval runs (see below).
Only add these if the user actually asked for a narrower or wider scope — the defaults are almost
always right.

Response:

```json
{
  "promptName": "support-agent-system-prompt",
  "currentVersion": 2,
  "currentText": "...",
  "exampleCount": 5,
  "examples": [
    { "source": "online_evaluator", "input": "...", "output": "...", "rating": 0, "justification": "..." },
    { "source": "eval_run", "input": "...", "output": "...", "rating": 6, "justification": "...", "expectedResults": "..." }
  ],
  "scope": { "versionScoped": true, "window": "7d" }
}
```

`examples` merges two sources, worst-rated first, capped at 20 total: deliberate Evaluate runs
tagged `evaluationSubject.metadata.promptName === promptName` (each may include `expectedResults`,
the dataset author's golden answer for that question — treat it as ground truth, not just the
`justification` paraphrase), and Online Evaluator ratings on real production traffic whose trace
was tagged the same way (`source: "online_evaluator"`, never has `expectedResults` — no dataset
behind live traffic). This is the exact same evidence the dashboard's "Suggest improvement" button
(and its server-side judge call) uses, just handed to you raw instead of through a judge.

Eval-run examples default to the *current published version only* (`scope.versionScoped: true`,
tag convention `<promptName>@v<currentVersion>`) — falling back to every version automatically if
that's fewer than 3 examples, reported back as `scope.versionScoped: false`. Mention this to the
user if it happened ("not enough recent examples on the current version, so this includes older
ones too"), same as the dashboard shows it.

If `exampleCount` is 0, tell the user there's nothing to learn from yet: they need to either run
their agent against a dataset via the SDK, tagging the run with
`subject={"metadata": {"promptName": "<name>"}}`, or send live traces tagged
`client.tracer.trace(name, metadata={"promptName": "<name>"})` through an enabled Online Evaluator,
and get some rated results first. Stop here.

## 4. Propose a rewrite yourself

Read `currentText` and every example's `input`/`output`/`rating`/`justification`, plus
`expectedResults` when present (treat it as ground truth for what the response should have looked
like) and `source` (eval-run examples were deliberate tests; `online_evaluator` examples are real
production traffic — both are real evidence, weigh them together). You are the judge here — there
is no separate API call for this step. Draft:

- A **complete** rewritten prompt (not a diff or a partial patch — the publish step below replaces
  the whole text).
- A short explanation of what changed and why, tied to the specific examples that motivated each
  change.

Show the user both the current text and your proposed rewrite side by side in the chat, plus your
reasoning, before doing anything else.

## 5. Wait for explicit approval

Do not publish automatically. Only proceed to step 6 after the user clearly approves in this
conversation (e.g. "yes", "publish it", "use that", "looks good") — a request to "improve the
prompt" is not itself approval of a specific rewrite, only of drafting one. If they ask for
changes, revise and show the new draft; if they decline, stop without calling anything further.

## 6. Publish the new version

Prompt text and your reasoning are free-form natural language — they will often contain quotes,
apostrophes, or newlines that break a hand-built `curl -d '{...}'` JSON string. Don't inline the
payload into the bash command. Instead, use the Write tool (not a bash heredoc) to write the exact
JSON body to a file, then send that file as-is:

Write `/tmp/agentx-improve-prompt.json` with content like:

```json
{
  "text": "<your full rewritten prompt, verbatim>",
  "source": "proposed",
  "reasoning": "<your short explanation from step 4>",
  "basedOnVersion": 2
}
```

(`basedOnVersion` is the `currentVersion` number from step 3 — a real number, not a string.) Then:

```bash
curl -s -X POST "<BASE_URL>/evaluate/prompts/<PROMPT_ID>/versions" \
  -H "x-api-key: <API_KEY>" -H "Content-Type: application/json" \
  --data-binary @/tmp/agentx-improve-prompt.json
```

This is the exact same write path the dashboard's own "Publish as new version" button uses — a
rewrite only ever reaches storage through this one human-approved call, whichever surface produced
it. The response is the updated prompt, including the new `version` number — confirm it matches
`basedOnVersion + 1` and report it back to the user. Remind them their agent's next
`client.evaluations.prompts.get("<name>")` call will pick up the new version immediately — this
skill never touches their agent's own code or deployment.

## If a request fails

If any `curl` call returns a non-2xx status or an `{"error": "..."}` body (wrong API key, engine
not running, prompt not found), show the user that exact error and stop — don't guess at a fix or
retry with different values silently.
