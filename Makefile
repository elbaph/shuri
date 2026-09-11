# Dev shortcuts. Run `make help` to list everything.
# Each target just wraps one existing npm/vsce/code command.
#
# For everyday development, press F5 in VS Code (Run Extension) rather than
# repackaging — it runs `make watch` under the hood and reloads much faster.
# `make dev` is for verifying real install behavior (e.g. marketplace update
# paths, cold-start activation) that only shows up once actually installed.

.DEFAULT_GOAL := help

PROFILE ?= side-project
VSIX := shuri-dev.vsix

.PHONY: help install compile watch lint format test package dev clean release

help: ## List all targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (run once after cloning)
	npm install

compile: ## Type-check + lint + esbuild bundle once into out/extension.js
	npm run compile

watch: ## esbuild + tsc watch together (F5 Run Extension uses .vscode/tasks.json; this is for plain CLI use)
	npm run watch

lint: ## ESLint
	npm run lint

format: ## Prettier, whole repo
	npm run format

test: ## Run tests (vscode-test, compiles first)
	npm test

package: ## Bundle and package into $(VSIX)
	npm run package

dev: package ## Package + install into a test profile (default $(PROFILE), override with PROFILE=xxx)
	code --profile "$(PROFILE)" --install-extension $(VSIX) --force
	@echo ""
	@echo "Installed -> switch to the '$(PROFILE)' profile window and reload it manually"
	@echo "(Cmd+Shift+P -> Developer: Reload Window) - a CLI install doesn't notify windows already open."

clean: ## Remove build output (out/) and the packaged vsix
	rm -rf out $(VSIX)

release: ## Bump version, tag, push, and cut a GitHub Release (triggers the publish workflow). Usage: make release VERSION=x.y.z|patch|minor|major
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release VERSION=x.y.z|patch|minor|major"; \
		exit 1; \
	fi
	npm version $(VERSION) -m "Release %s"
	git push && git push --tags
	gh release create "v$$(node -p "require('./package.json').version")" --generate-notes
