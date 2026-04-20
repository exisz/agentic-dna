.PHONY: build install dev clean pack

# Build CLI (tsup) + OpenClaw plugin (TS → JS)
build:
	pnpm build
	cd openclaw && pnpm build

# Build + copy-install to OpenClaw
# Auto-triggered by post-commit hook when openclaw/ or lib/ files change
install: build
	@TMPDIR=$$(mktemp -d) && \
	cp openclaw/package.json "$$TMPDIR/" && \
	cp openclaw/openclaw.plugin.json "$$TMPDIR/" && \
	cp -r openclaw/dist "$$TMPDIR/" && \
	cp -r openclaw/skills "$$TMPDIR/" && \
	openclaw plugins install --dangerously-force-unsafe-install --force "$$TMPDIR" && \
	rm -rf "$$TMPDIR" && \
	echo "" && \
	echo "✅ Installed. Run 'openclaw gateway restart' to load."

# Build + install + restart gateway
dev: install
	openclaw gateway restart

# Clean build artifacts
clean:
	rm -rf dist openclaw/dist

# Pack for npm publish
pack: build
	cd openclaw && pnpm pack
