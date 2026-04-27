# 🧬 vscode-dna

> Language support for `.dna` files — the unified format for [agentic-dna](https://github.com/exisz/agentic-dna) governance systems.

![VS Code](https://img.shields.io/badge/VS_Code-1.85+-blue?logo=visualstudiocode)
![License](https://img.shields.io/badge/license-MIT-green)

## What is `.dna`?

`.dna` is a **unified file extension** for AI agent fleet governance. A single `.dna` file can contain either:

- **Pure YAML** — node definitions (agents, tools, projects, etc.)
- **Markdown + YAML frontmatter** — rich documentation (philosophies, flows, conventions)

The extension auto-detects the format and provides the right experience.

## Features

### 🎨 Syntax Highlighting
- Auto-detects YAML vs Markdown+frontmatter mode
- `dna://` URIs highlighted as links everywhere
- DNA-specific YAML field highlighting

### 🔗 dna:// Link Navigation
- **Ctrl+Click** any `dna://type/name` URI to jump to its definition
- **Hover** over URIs to preview node title, type, and status
- **Go to Definition** (F12) for `dna://` URIs

### 💡 IntelliSense
- Autocomplete for `id:`, `type:`, `status:`, and `links:` fields
- `dna://` URI completion with type suggestions
- JSON Schema validation for YAML-mode files

### ✂️ Snippets

| Prefix | Description |
|--------|-------------|
| `dna-agent` | Agent node template |
| `dna-tool` | Tool node template |
| `dna-philosophy` | Philosophy (Markdown+frontmatter) |
| `dna-flow` | Flow procedure (Markdown+frontmatter) |
| `dna-project` | Project node template |
| `dna-link` | `dna://` URI |

### 🖼️ File Icon
Custom DNA helix icon in the VS Code file explorer for `.dna` files.

## Quick Start

```bash
# Install from .vsix
code --install-extension vscode-dna-0.1.0.vsix
```

Create a file ending in `.dna` and start typing. Try `dna-agent` + Tab for a quick template:

```yaml
id: dna://agent/nebula
type: agent
title: "Nebula Governor"
status: active
goal: Incubate open source tools
links:
  - dna://realm/empire-middleware
  - dna://tool/lazyjira
```

Or a Markdown-mode philosophy:

```markdown
---
id: dna://philosophy/readme-is-product
type: philosophy
title: "README is the Product"
status: active
---

# README is the Product

> Code is infrastructure. README is the product.

## Rules

- The 30-second test: what, install, use, looks like
- README IS the docs for 90% of users
```

## dna:// URI Format

```
dna://<type>/<name>
```

Types: `agent`, `realm`, `philosophy`, `convention`, `protocol`, `flow`, `tool`, `repo`, `host`, `project`, `site`, `skill`, `middleware`, `maintained-oss`

## Build from Source

```bash
npm install
npm run compile
npm run package    # creates .vsix
```

## License

MIT
