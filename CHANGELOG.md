# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] — 2026-04-15

### Added
- add bump target with CHANGELOG generation (1db8e1d)
- initial repository setup (923afc5)

### Fixed
- add lockfile and align node version with .tool-versions (7e73fb3)

### Maintenance
- 🔇 fix: silence verbose logs in production via COST_GUARD_DEBUG (61105f5)
- 🐛 fix: strip comments from config before JSON.parse (8a33f66)
- 🐛 fix: use os.homedir() instead of process.env.HOME for config lookup (577956d)
- 🐛 fix: add id to plugin module export (afd1b01)
- 🔊 feat: add diagnostic logs to surface runtime state (cf1a204)
- 🐛 fix: use PluginModule object as default export (a356299)
- 🐛 fix: export server to match PluginModule contract (7f16f5e)
- 🥅 fix: surface errors instead of silently swallowing them (43bf591)
- 🐛 fix: resolve type errors from incorrect SDK usage (6864304)
- add AGENTS.md for agent session ramp-up (a9b93de)
- sync docs with current code and Makefile (5454207)
