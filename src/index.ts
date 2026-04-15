/**
 * opencode-cost-guard
 *
 * OpenCode plugin that monitors session cost in real time and triggers
 * a warning or stop when a configurable threshold is reached.
 *
 * @see https://github.com/jjmartres/opencode-cost-guard
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CostGuardConfig {
  /** Cost limit in USD. Session triggers an alert when this is exceeded. Default: 2.0 */
  maxCostUsd: number
  /** Percentage of maxCostUsd at which an early warning fires. 0 to disable. Default: 80 */
  warnAtPercent: number
  /** "warn" sends a warning message; "block" additionally marks the session as stopped. Default: "warn" */
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
    join(process.env.HOME ?? "", ".config", "opencode", CONFIG_FILENAME),
  ]

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue

    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<CostGuardConfig>
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

      console.info(`[cost-guard] Config loaded from: ${configPath}`)
      return config
    } catch (err) {
      console.warn(`[cost-guard] Failed to read ${configPath}:`, err)
    }
  }

  console.info("[cost-guard] No config file found, using defaults.")
  return { ...DEFAULTS }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (usd: number) => `$${usd.toFixed(4)}`
const pct = (cost: number, max: number) => Math.round((cost / max) * 100)

async function sendMessage(
  client: any,
  sessionId: string,
  text: string
): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: { noReply: true, parts: [{ type: "text", text }] },
  })
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const CostGuardPlugin: Plugin = async ({ client, directory }) => {
  const cfg = loadConfig(directory)

  console.info(
    `[cost-guard] Active — limit: ${fmt(cfg.maxCostUsd)} | ` +
    `warn at: ${cfg.warnAtPercent}% | mode: ${cfg.mode}`
  )

  // Track per-session state to avoid duplicate messages
  const warnedSessions  = new Set<string>()
  const blockedSessions = new Set<string>()

  return {
    event: async ({ event }) => {
      // Only act after the model has finished responding
      if (event.type !== "session.idle") return

      const sessionId: string | undefined =
        (event as any).properties?.info?.id

      if (!sessionId || blockedSessions.has(sessionId)) return

      // Fetch current session cost via SDK
      let cost = 0
      try {
        const resp = await client.session.get({ path: { id: sessionId } })
        cost = resp.data?.cost ?? 0
      } catch {
        // SDK temporarily unavailable — skip silently
        return
      }

      const { maxCostUsd, warnAtPercent, mode } = cfg
      const warnThreshold = maxCostUsd * (warnAtPercent / 100)

      // ── Limit reached ────────────────────────────────────────────────────────
      if (cost >= maxCostUsd) {
        blockedSessions.add(sessionId)

        const msg =
          mode === "block"
            ? [
                `⛔ **COST LIMIT REACHED** — Session automatically stopped.`,
                `Cost: ${fmt(cost)} / Limit: ${fmt(maxCostUsd)} (${pct(cost, maxCostUsd)}%)`,
                ``,
                `This session will no longer respond to new requests.`,
                `Start a new session to continue working.`,
              ].join("\n")
            : [
                `⛔ **COST LIMIT REACHED** — Cost: ${fmt(cost)} / ${fmt(maxCostUsd)} (${pct(cost, maxCostUsd)}%)`,
                ``,
                `Configured limit reached. Consider starting a new session or`,
                `update "maxCostUsd" in ${CONFIG_FILENAME}.`,
              ].join("\n")

        await sendMessage(client, sessionId, msg)
        return
      }

      // ── Early warning (fired once per session) ────────────────────────────────
      if (
        warnAtPercent > 0 &&
        cost >= warnThreshold &&
        !warnedSessions.has(sessionId)
      ) {
        warnedSessions.add(sessionId)

        await sendMessage(client, sessionId, [
          `⚠️  **COST WARNING** — ${pct(cost, maxCostUsd)}% of budget used.`,
          `Cost: ${fmt(cost)} — Limit: ${fmt(maxCostUsd)} — Remaining: ${fmt(maxCostUsd - cost)}`,
        ].join("\n"))
      }
    },
  }
}

export default CostGuardPlugin
