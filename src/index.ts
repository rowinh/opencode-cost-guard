/**
 * opencode-cost-guard
 *
 * OpenCode plugin that checks session cost after each response and sends
 * a warning or limit alert when a configurable threshold is reached.
 * Supports both the V1 (@opencode-ai/plugin) and V2 (@opencode/plugin) hosts.
 *
 * @see https://github.com/jjmartres/opencode-cost-guard
 */

// Type-only imports: neither SDK is needed at runtime, so the package loads
// on either host without pulling in the other's dependencies.
import type { Plugin as PluginV1, PluginModule } from "@opencode-ai/plugin"
import type { Plugin as V2 } from "@opencode/plugin"
import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// ─── Logging ──────────────────────────────────────────────────────────────────

/**
 * Verbose debug logging is opt-in via COST_GUARD_DEBUG=1.
 * Warnings and errors always print regardless of this flag.
 */
const DEBUG = process.env.COST_GUARD_DEBUG === "1"

const log = {
  /** Always printed — startup confirmation and real errors only. */
  info:  (msg: string) => console.info(`[cost-guard] ${msg}`),
  /** Always printed — something the user should act on. */
  warn:  (msg: string, err?: unknown) => err
    ? console.warn(`[cost-guard] ${msg}`, err)
    : console.warn(`[cost-guard] ${msg}`),
  /** Always printed — unexpected failures. */
  error: (msg: string, err?: unknown) => err
    ? console.error(`[cost-guard] ${msg}`, err)
    : console.error(`[cost-guard] ${msg}`),
  /** Printed only when COST_GUARD_DEBUG=1 — high-frequency / verbose lines. */
  debug: (msg: string) => { if (DEBUG) console.info(`[cost-guard] ${msg}`) },
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostGuardConfig {
  /** Cost limit in USD. Session triggers an alert when this is exceeded. Default: 20.0 */
  maxCostUsd: number
  /** Percentage of maxCostUsd at which an early warning fires. 0 to disable. Default: 80 */
  warnAtPercent: number
  /** "warn" sends an alert; "block" also rejects subsequent prompts once the limit is reached (V2 only). Default: "warn" */
  mode: "warn" | "block"
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: CostGuardConfig = {
  maxCostUsd: 20.0,
  warnAtPercent: 80,
  mode: "warn",
}

const CONFIG_FILENAME = "cost-guard.config.json"

// ─── Config loading ───────────────────────────────────────────────────────────

/**
 * Loads plugin config from disk.
 *
 * Priority order (first found wins):
 *   1. <project>/.opencode/cost-guard.config.json
 *   2. ~/.config/opencode/cost-guard.config.json
 *   3. Built-in defaults
 */
export function loadConfig(projectDirectory: string): CostGuardConfig {
  const candidates = [
    join(projectDirectory, ".opencode", CONFIG_FILENAME),
    join(homedir(), ".config", "opencode", CONFIG_FILENAME),
  ]

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue

    try {
      const raw = readFileSync(configPath, "utf-8")
        .replace(/\/\/[^\n]*/g, "")        // strip // line comments
        .replace(/\/\*[\s\S]*?\*\//g, "")  // strip /* block comments */
      const parsed = JSON.parse(raw) as Partial<CostGuardConfig>
      const config: CostGuardConfig = { ...DEFAULTS }

      if (typeof parsed.maxCostUsd === "number" && parsed.maxCostUsd > 0)
        config.maxCostUsd = parsed.maxCostUsd

      if (
        typeof parsed.warnAtPercent === "number" &&
        parsed.warnAtPercent >= 0 &&
        parsed.warnAtPercent <= 100
      )
        config.warnAtPercent = parsed.warnAtPercent

      if (parsed.mode === "warn" || parsed.mode === "block")
        config.mode = parsed.mode

      log.debug(`Config loaded from: ${configPath}`)
      return config
    } catch (err) {
      log.warn(`Failed to read ${configPath}:`, err)
    }
  }

  log.debug(`No config file found (checked: ${candidates.join(", ")}), using defaults.`)
  return { ...DEFAULTS }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (usd: number) => `$${usd.toFixed(4)}`
const pct = (cost: number, max: number) => Math.round((cost / max) * 100)

/** Always printed — one line at startup so the user can confirm active config. */
function logActive(cfg: CostGuardConfig): void {
  log.info(
    `Active — limit: ${fmt(cfg.maxCostUsd)} | ` +
    `warn at: ${cfg.warnAtPercent}% | mode: ${cfg.mode}` +
    (DEBUG ? " | debug: on" : "")
  )
}

// ─── Cost check (shared by V1 and V2) ─────────────────────────────────────────

/**
 * Tracks per-session state and sends each notification at most once.
 * `send` delivers text to the session without triggering a model response.
 * `enforced` says whether the host rejects prompts in block mode (V2 only),
 * so the limit message never promises blocking that isn't happening.
 */
function createCostGuard(
  cfg: CostGuardConfig,
  enforced: boolean,
  send: (sessionId: string, text: string) => Promise<unknown>
) {
  const warnedSessions = new Set<string>()
  const limitNotifiedSessions = new Set<string>()

  // Errors are logged and swallowed — a failed notification must never
  // crash the event handler or suppress future cost checks.
  async function notify(sessionId: string, text: string): Promise<boolean> {
    try {
      await send(sessionId, text)
      return true
    } catch (err) {
      log.warn(`Failed to send message to session ${sessionId}:`, err)
      return false
    }
  }

  return {
    /** True once the limit alert was delivered; later checks can be skipped. */
    isDone: (sessionId: string) => limitNotifiedSessions.has(sessionId),

    async check(sessionId: string, cost: number): Promise<void> {
      const { maxCostUsd, warnAtPercent, mode } = cfg
      log.debug(`session ${sessionId} — cost: ${fmt(cost)}, limit: ${fmt(maxCostUsd)}`)

      // ── Limit reached ────────────────────────────────────────────────────────
      if (cost >= maxCostUsd) {
        const usage = `Cost: ${fmt(cost)} / Limit: ${fmt(maxCostUsd)} (${pct(cost, maxCostUsd)}%)`
        const msg =
          mode === "warn"
            ? [
                `⛔ **COST LIMIT REACHED** — Cost: ${fmt(cost)} / ${fmt(maxCostUsd)} (${pct(cost, maxCostUsd)}%)`,
                ``,
                `Configured limit reached. Consider starting a new session or`,
                `update "maxCostUsd" in ${CONFIG_FILENAME}.`,
              ].join("\n")
            : enforced
              ? [
                  `⛔ **COST LIMIT REACHED** — New prompts blocked.`,
                  usage,
                  ``,
                  `New prompts in this session will be rejected.`,
                  `Start a new session to continue working.`,
                ].join("\n")
              : [
                  `⛔ **COST LIMIT REACHED** — Stop using this session.`,
                  usage,
                  ``,
                  `Prompt blocking requires OpenCode V2; on V1 this is an alert only.`,
                  `Start a new session to continue working.`,
                ].join("\n")

        if (await notify(sessionId, msg)) limitNotifiedSessions.add(sessionId)
        return
      }

      // ── Early warning (fired once per session) ─────────────────────────────
      if (
        warnAtPercent > 0 &&
        cost >= maxCostUsd * (warnAtPercent / 100) &&
        !warnedSessions.has(sessionId)
      ) {
        if (await notify(sessionId, [
          `⚠️  **COST WARNING** — ${pct(cost, maxCostUsd)}% of budget used.`,
          `Cost: ${fmt(cost)} — Limit: ${fmt(maxCostUsd)} — Remaining: ${fmt(maxCostUsd - cost)}`,
        ].join("\n"))) warnedSessions.add(sessionId)
      }
    },
  }
}

// ─── OpenCode V1 ──────────────────────────────────────────────────────────────

export const CostGuardPlugin: PluginV1 = async ({ client, directory }) => {
  const cfg = loadConfig(directory)
  logActive(cfg)

  const guard = createCostGuard(cfg, false, (sessionId, text) =>
    client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text }] },
    })
  )

  return {
    event: async ({ event }) => {
      // Only act after the model has finished responding
      if (event.type !== "session.idle") return

      const sessionId = event.properties.sessionID
      log.debug(`session.idle received — sessionId: ${sessionId ?? "(none)"}`)

      if (!sessionId || guard.isDone(sessionId)) return

      try {
        // Sum cost across all assistant messages in the session
        let cost = 0
        try {
          const resp = await client.session.messages({ path: { id: sessionId } })
          for (const { info } of resp.data ?? []) {
            if (info.role === "assistant") cost += info.cost
          }
        } catch (err) {
          log.warn(`Could not fetch messages for session ${sessionId}:`, err)
          return
        }

        await guard.check(sessionId, cost)
      } catch (err) {
        // Defensive catch — an unexpected error must not silence future events
        log.error(`Unexpected error in event handler (session ${sessionId}):`, err)
      }
    },
  }
}

// ─── OpenCode V2 ──────────────────────────────────────────────────────────────

async function setupV2(ctx: V2.Context): Promise<V2.Cleanup> {
  const cfg = loadConfig(ctx.location.directory)
  logActive(cfg)

  const guard = createCostGuard(cfg, true, (sessionId, text) =>
    ctx.session.synthetic({ sessionID: sessionId, text, resume: false })
  )
  // The idle subscription and the prompt hook can see sessions from other
  // locations; only apply this project's config to this project's sessions.
  const ownsSession = (session: { location: { directory: string } }) =>
    session.location.directory === ctx.location.directory

  const registrations: Array<{ dispose: () => Promise<void> }> = []

  if (cfg.mode === "block") {
    // Check the durable session total, including after a plugin reload or service restart.
    registrations.push(await ctx.session.hook("prompt", async (event) => {
      let session
      try {
        session = await ctx.session.get({ sessionID: event.sessionID })
      } catch (err) {
        // Fail open: a transient lookup failure must not lock the user out.
        // The next session.idle check still reports an overspend.
        log.warn(`Could not check cost for session ${event.sessionID}; allowing prompt:`, err)
        return
      }
      if (!ownsSession(session) || session.cost < cfg.maxCostUsd) return
      throw new Error(`Cost limit reached (${fmt(session.cost)} / ${fmt(cfg.maxCostUsd)}). Start a new session to continue.`)
    }))
  }

  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      // Only act after the model has finished responding.
      if (event.type !== "session.idle") continue
      if (event.location && event.location.directory !== ctx.location.directory) continue

      const sessionId = event.data.sessionID
      log.debug(`session.idle received — sessionId: ${sessionId}`)

      if (!sessionId || guard.isDone(sessionId)) continue

      try {
        // V2 exposes the cumulative session cost directly; context may be compacted.
        const session = await ctx.session.get({ sessionID: sessionId })
        if (!ownsSession(session)) continue
        await guard.check(sessionId, session.cost)
      } catch (err) {
        log.error(`Could not check cost for session ${sessionId}:`, err)
      }
    }
    // The host runs our cleanup (which aborts) before closing streams on unload,
    // so reaching here without an abort means the stream ended on its own.
    if (!controller.signal.aborted) log.warn("Event subscription ended; cost alerts are off until the plugin reloads.")
  })().catch((err) => {
    if (!controller.signal.aborted) log.error("Event subscription stopped:", err)
  })

  return async () => {
    controller.abort()
    await Promise.all(registrations.map((r) => r.dispose()))
  }
}

// ─── Plugin module ────────────────────────────────────────────────────────────

// One default export serves both hosts: the V1 loader reads `server` and
// ignores `setup`; the V2 loader reads `setup` and ignores `server`.
// V1 requires a plain-object default export — exporting CostGuardPlugin
// directly makes its legacy fallback call every named export as a plugin,
// including loadConfig(). `id` is mandatory for file:// plugins on V1 and
// for every plugin on V2.
const plugin = {
  id: "opencode-cost-guard",
  server: CostGuardPlugin,
  setup: setupV2,
} satisfies PluginModule & V2.Plugin

export default plugin
