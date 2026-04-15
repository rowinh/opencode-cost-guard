# =============================================================================
# opencode-cost-guard — developer workflow
# =============================================================================
# Usage: make <target>
#
# Targets are grouped into five stages:
#   env      — set up the local environment (Node via asdf, npm deps)
#   dev      — inner development loop (type-check, build, watch, clean)
#   info     — inspect current state (versions, package contents)
#   release  — bump version and push the release tag
#   help     — print this reference (default target)
# =============================================================================

# ── Meta ─────────────────────────────────────────────────────────────────────

PACKAGE_NAME   := $(shell node -p "require('./package.json').name"      2>/dev/null || echo "opencode-cost-guard")
PACKAGE_VER    := $(shell node -p "require('./package.json').version"   2>/dev/null || echo "unknown")
NODE_REQUIRED  := $(shell node -p "require('./package.json').engines.node.replace('>=','')" 2>/dev/null || echo "20")
NODE_CURRENT   := $(shell node --version 2>/dev/null | tr -d 'v' || echo "not found")
NPM_CURRENT    := $(shell npm  --version 2>/dev/null || echo "not found")

# Colour helpers (degrade gracefully in non-TTY environments)
BOLD  := $(shell tput bold   2>/dev/null || echo "")
GREEN := $(shell tput setaf 2 2>/dev/null || echo "")
CYAN  := $(shell tput setaf 6 2>/dev/null || echo "")
RESET := $(shell tput sgr0   2>/dev/null || echo "")

.DEFAULT_GOAL := help

.PHONY: help env install build check dev clean info \
        release-patch release-minor release-major \
        _require-clean-tree _require-node

# =============================================================================
# HELP
# =============================================================================

help: ## Show this help message
	@printf '\n$(BOLD)$(CYAN)opencode-cost-guard$(RESET) — developer workflow\n\n'
	@printf '$(BOLD)Usage:$(RESET)  make <target>\n\n'
	@printf '$(BOLD)Targets:$(RESET)\n'
	@awk 'BEGIN { FS = ":.*##" } \
	     /^[a-zA-Z_-]+:.*##/ { printf "  $(CYAN)%-18s$(RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\n'

# =============================================================================
# ENV — environment setup
# =============================================================================

env: _require-asdf ## Install the pinned Node.js version via asdf and npm deps
	@printf '$(BOLD)$(GREEN)» Installing Node.js $(shell cat .tool-versions | awk "{print \$$2}") via asdf…$(RESET)\n'
	asdf install
	@$(MAKE) --no-print-directory install

_require-asdf:
	@command -v asdf >/dev/null 2>&1 || { \
	  printf '$(BOLD)error:$(RESET) asdf is not installed.\n'; \
	  printf '  Install it from https://asdf-vm.com and re-run: make env\n'; \
	  exit 1; \
	}

install: ## Install npm dependencies (uses ci when package-lock exists)
	@if [ -f package-lock.json ]; then \
	  printf '$(BOLD)$(GREEN)» npm ci$(RESET)\n'; \
	  npm ci; \
	else \
	  printf '$(BOLD)$(GREEN)» npm install$(RESET)\n'; \
	  npm install; \
	fi

# =============================================================================
# DEV — inner development loop
# =============================================================================

check: _require-node ## Type-check sources without emitting files
	@printf '$(BOLD)$(GREEN)» Type-checking…$(RESET)\n'
	npm run build:check

build: _require-node ## Compile TypeScript → dist/
	@printf '$(BOLD)$(GREEN)» Building…$(RESET)\n'
	npm run build

dev: _require-node ## Start watch mode (recompiles on save)
	@printf '$(BOLD)$(GREEN)» Watch mode — Ctrl-C to stop$(RESET)\n'
	npm run dev

clean: ## Remove compiled output (dist/)
	@printf '$(BOLD)$(GREEN)» Cleaning dist/…$(RESET)\n'
	npm run clean

rebuild: clean build ## Clean then rebuild from scratch

# =============================================================================
# INFO — inspect current state
# =============================================================================

info: ## Show local and published package versions
	@printf '\n$(BOLD)Local$(RESET)\n'
	@printf '  package   %s\n' "$(PACKAGE_NAME)"
	@printf '  version   %s\n' "$(PACKAGE_VER)"
	@printf '  node      %s  (required ≥ %s)\n' "$(NODE_CURRENT)" "$(NODE_REQUIRED)"
	@printf '  npm       %s\n' "$(NPM_CURRENT)"
	@printf '\n$(BOLD)npm registry$(RESET)\n'
	@npm view $(PACKAGE_NAME) version 2>/dev/null \
	  && printf '' \
	  || printf '  (not yet published)\n'
	@printf '\n'

pack-preview: build ## Dry-run pack — shows exactly what will be published
	@printf '$(BOLD)$(GREEN)» Previewing npm pack…$(RESET)\n'
	npm pack --dry-run

# =============================================================================
# RELEASE — bump version and push tag to trigger CI publish
# =============================================================================
# CI (publish.yml) handles the actual `npm publish` when a v* tag is pushed.
# These targets only bump the version locally and push.

release-patch: _require-clean-tree _require-node ## Bump patch version (1.0.0 → 1.0.1) and push tag
	@$(MAKE) --no-print-directory _do-release BUMP=patch

release-minor: _require-clean-tree _require-node ## Bump minor version (1.0.0 → 1.1.0) and push tag
	@$(MAKE) --no-print-directory _do-release BUMP=minor

release-major: _require-clean-tree _require-node ## Bump major version (1.0.0 → 2.0.0) and push tag
	@$(MAKE) --no-print-directory _do-release BUMP=major

_do-release:
	@printf '$(BOLD)$(GREEN)» Bumping $(BUMP) version from $(PACKAGE_VER)…$(RESET)\n'
	npm run version:$(BUMP)
	@NEW_VER=$$(node -p "require('./package.json').version"); \
	printf '$(BOLD)$(GREEN)» Pushing v$$NEW_VER…$(RESET)\n'; \
	git push && git push --tags; \
	printf '\n$(BOLD)$(GREEN)✓ Released v$$NEW_VER$(RESET)\n'; \
	printf '  CI will publish to npm once the tag build passes.\n\n'

# =============================================================================
# GUARDS — internal prerequisite checks
# =============================================================================

_require-node:
	@command -v node >/dev/null 2>&1 || { \
	  printf '$(BOLD)error:$(RESET) node is not on PATH.\n'; \
	  printf '  Run: make env\n'; \
	  exit 1; \
	}

_require-clean-tree:
	@if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then \
	  printf '$(BOLD)error:$(RESET) working tree has uncommitted changes.\n'; \
	  printf '  Commit or stash them before releasing.\n'; \
	  git status --short; \
	  exit 1; \
	fi
