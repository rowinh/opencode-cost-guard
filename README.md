# opencode-cost-guard

An [OpenCode](https://opencode.ai) plugin that checks session cost after each response and sends a **warning** or **limit** message when a configurable spending threshold is reached. Works with both OpenCode V1 and [OpenCode V2](https://opencode.ai/v2/docs/).

> **Why?** OpenCode has no built-in per-session cost limit. This plugin fills that gap while a [native feature](https://github.com/sst/opencode/issues/4559) is still pending.

---

## Features

- ⚠️ **Early warning** at a configurable percentage of the budget (e.g. 80%)
- ⛔ **Limit alert** when the session cost exceeds the threshold
- 🔇 **No spam** — each message fires at most once per session
- 🗂️ **Per-project config** — override the global limit for individual repositories
- 🔌 **Zero friction** — install via npm, one line in `opencode.json`

---

## Installation

Add the package name to your OpenCode config — `plugins` on OpenCode V2, `plugin` on V1:

```jsonc
// ~/.config/opencode/opencode.json  (global)
// or .opencode/opencode.json        (per-project)
{
  "plugins": ["opencode-cost-guard"]   // OpenCode V2
  // "plugin": ["opencode-cost-guard"] // OpenCode V1
}
```

OpenCode resolves and installs the plugin from npm on startup.

---

## Configuration

Create a config file. It is read when the plugin loads; reload the plugin or restart OpenCode after changing it.

### Global config

```
~/.config/opencode/cost-guard.config.json
```

### Per-project override (takes priority over global)

```
<project-root>/.opencode/cost-guard.config.json
```

### Config reference

The file must be valid JSON — comments are stripped before parsing so `//` and `/* */` comments are accepted, but trailing commas are not.

| Key             | Type              | Default  | Description                                                    |
| --------------- | ----------------- | -------- | -------------------------------------------------------------- |
| `maxCostUsd`    | number            | `20.0`   | Cost limit in USD. Alert fires when this is exceeded.          |
| `warnAtPercent` | number (0 – 100)  | `80`     | Early warning threshold as a % of `maxCostUsd`. `0` to disable.|
| `mode`          | `"warn"` \| `"block"` | `"warn"` | `warn` — sends an alert. `block` — also rejects new prompts after the limit (V2 only; alert-only on V1). |

```json
{
  "maxCostUsd": 20.0,
  "warnAtPercent": 80,
  "mode": "warn"
}
```

If no config file is found, the built-in defaults above apply.

---

## How it works

The plugin listens for the `session.idle` event, which fires after a session finishes responding. It then:

1. Reads the session ID from the event payload
2. Gets the cumulative session cost — V2 reports it directly; on V1 the plugin sums the cost of the session's assistant messages
3. Compares it against the configured thresholds
4. Adds a notification to the session without triggering a model response

The same package loads on both hosts: its default export provides a V1 `server()` entry point and a V2 `setup()` entry point, and each host uses its own.

On V2 in `block` mode, a prompt hook checks the current session cost and rejects later prompts once the threshold has been reached. If that cost lookup fails, the prompt is allowed rather than locking you out. V2 has no typed prompt-rejection API, so a blocked prompt may appear as a generic error in some clients. V1 has no way for a plugin to reject a prompt, so `block` mode there sends the limit alert only.

Either way, the alert arrives **after** a response: an in-flight response can exceed the limit.

```
User prompt → Model response → session.idle → cost-guard checks → ⚠️ or ⛔ if needed
```

### Deduplication

Two in-memory `Set` objects track which sessions have already received a warning or limit notification. Each notification fires **at most once per session** while the plugin remains loaded. On V2 in `block` mode, the prompt hook reads the durable session cost, so blocking still applies after a restart.

---

## Startup log

The plugin always prints one line at startup confirming the active configuration:

```
[cost-guard] Active — limit: $20.0000 | warn at: 80% | mode: warn
```

That is the only log line produced during normal operation. Warnings and errors always print regardless.

### Debug logging

Set `COST_GUARD_DEBUG=1` to enable verbose per-event logs — useful when diagnosing why a threshold isn't firing:

```
[cost-guard] Active — limit: $20.0000 | warn at: 80% | mode: warn | debug: on
[cost-guard] Config loaded from: /Users/you/.config/opencode/cost-guard.config.json
[cost-guard] session.idle received — sessionId: abc123
[cost-guard] session abc123 — cost: $16.4000, limit: $20.0000
```

To set the variable for an OpenCode session launched from the terminal:

```bash
COST_GUARD_DEBUG=1 opencode
```

---

## Example messages

**Early warning (at 80% of budget)**

```
⚠️  **COST WARNING** — 82% of budget used.
Cost: $16.4000 — Limit: $20.0000 — Remaining: $3.6000
```

**Limit reached — `warn` mode**

```
⛔ **COST LIMIT REACHED** — Cost: $20.0031 / $20.0000 (100%)

Configured limit reached. Consider starting a new session or
update "maxCostUsd" in cost-guard.config.json.
```

**Limit reached — `block` mode (V2)**

```
⛔ **COST LIMIT REACHED** — New prompts blocked.
Cost: $20.0031 / Limit: $20.0000 (100%)

New prompts in this session will be rejected.
Start a new session to continue working.
```

**Limit reached — `block` mode (V1)**

```
⛔ **COST LIMIT REACHED** — Stop using this session.
Cost: $20.0031 / Limit: $20.0000 (100%)

Prompt blocking requires OpenCode V2; on V1 this is an alert only.
Start a new session to continue working.
```

---

## Development

```bash
git clone https://github.com/jjmartres/opencode-cost-guard.git
cd opencode-cost-guard

make env      # install pinned Node (via asdf) + npm deps
make check    # type-check without emitting files
make build    # compile TypeScript → dist/
make dev      # watch mode — recompiles on save
make clean    # remove dist/
```

Run `make` with no arguments to see all available targets, including `bump` for version management and `release-*` for publishing. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

### Testing locally

Point OpenCode at your local build instead of the npm package:

```jsonc
// .opencode/opencode.json  (in a test project)
{
  "plugins": ["file:///absolute/path/to/opencode-cost-guard/dist/index.js"]   // V2
  // "plugin": ["file:///absolute/path/to/opencode-cost-guard/dist/index.js"] // V1
}
```

Then open OpenCode in that project and verify the startup log appears.

---

## Known limitations

- The limit is **reactive**, not preventive. A single expensive response can push the cost over the threshold before the plugin fires.
- In-memory notification state is reset when OpenCode restarts, so an existing session may receive the alert again. On V2, `block` mode still checks the persisted cost before admitting new prompts.
- On V1, `block` mode cannot reject prompts; it sends the limit alert only.
- For a hard preventive limit, consider routing through a gateway like [Portkey](https://portkey.ai) which supports budget enforcement at the API level.

---

## License

[MIT](./LICENSE)
