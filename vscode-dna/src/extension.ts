import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const DNA_URI_PATTERN = /dna:\/\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)/g;
const DNA_URI_PATTERN_SINGLE = /dna:\/\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)/;

/**
 * Detect if a .dna file is Markdown+frontmatter or pure YAML.
 */
function isDnaMarkdown(text: string): boolean {
  return /^\s*---\s*\n/.test(text) && /\n---\s*\n/.test(text.substring(3));
}

/**
 * Parse frontmatter YAML from a DNA Markdown file. Returns raw key-value pairs.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

/**
 * Parse YAML-mode .dna file for id/type/title.
 */
function parseYamlNode(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const kv = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

/**
 * Search workspace for .dna files matching a dna:// URI.
 */
async function findDnaFile(type: string, name: string): Promise<vscode.Uri | undefined> {
  const targetId = `dna://${type}/${name}`;
  const files = await vscode.workspace.findFiles('**/*.dna', '**/node_modules/**', 200);
  for (const uri of files) {
    try {
      const content = (await vscode.workspace.fs.readFile(uri)).toString();
      if (content.includes(targetId)) {
        // Verify it's the `id:` field
        const node = isDnaMarkdown(content) ? parseFrontmatter(content) : parseYamlNode(content);
        if (node.id === targetId) return uri;
      }
    } catch { /* skip unreadable */ }
  }
  return undefined;
}

/**
 * Get the dna:// URI range at a position in a document.
 */
function getDnaUriAtPosition(document: vscode.TextDocument, position: vscode.Position): { uri: string; type: string; name: string; range: vscode.Range } | undefined {
  const line = document.lineAt(position).text;
  let match: RegExpExecArray | null;
  const re = new RegExp(DNA_URI_PATTERN.source, 'g');
  while ((match = re.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        uri: match[0],
        type: match[1],
        name: match[2],
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  return undefined;
}

// ── Document Link Provider ──────────────────────────────────────────

class DnaDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;
      let match: RegExpExecArray | null;
      const re = new RegExp(DNA_URI_PATTERN.source, 'g');
      while ((match = re.exec(line)) !== null) {
        const range = new vscode.Range(i, match.index, i, match.index + match[0].length);
        const link = new vscode.DocumentLink(range);
        link.tooltip = `Follow ${match[0]}`;
        links.push(link);
      }
    }
    return links;
  }

  async resolveDocumentLink(link: vscode.DocumentLink): Promise<vscode.DocumentLink | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return undefined;
    const text = doc.getText(link.range);
    const m = text.match(DNA_URI_PATTERN_SINGLE);
    if (!m) return undefined;
    const uri = await findDnaFile(m[1], m[2]);
    if (uri) {
      link.target = uri;
    }
    return link;
  }
}

// ── Hover Provider ──────────────────────────────────────────────────

class DnaHoverProvider implements vscode.HoverProvider {
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const hit = getDnaUriAtPosition(document, position);
    if (!hit) return undefined;

    const fileUri = await findDnaFile(hit.type, hit.name);
    if (!fileUri) {
      return new vscode.Hover(
        new vscode.MarkdownString(`🧬 \`${hit.uri}\`\n\n*No matching .dna file found in workspace*`),
        hit.range
      );
    }

    const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
    const node = isDnaMarkdown(content) ? parseFrontmatter(content) : parseYamlNode(content);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`🧬 **${node.title || hit.name}**\n\n`);
    md.appendMarkdown(`- **Type:** ${node.type || hit.type}\n`);
    md.appendMarkdown(`- **ID:** \`${hit.uri}\`\n`);
    if (node.status) md.appendMarkdown(`- **Status:** ${node.status}\n`);
    if (node.goal) md.appendMarkdown(`- **Goal:** ${node.goal}\n`);
    md.appendMarkdown(`\n*${path.basename(fileUri.fsPath)}*`);
    return new vscode.Hover(md, hit.range);
  }
}

// ── Definition Provider ─────────────────────────────────────────────

class DnaDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
    const hit = getDnaUriAtPosition(document, position);
    if (!hit) return undefined;
    const fileUri = await findDnaFile(hit.type, hit.name);
    if (!fileUri) return undefined;
    return new vscode.Location(fileUri, new vscode.Position(0, 0));
  }
}

// ── Completion Provider ─────────────────────────────────────────────

class DnaCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
    const linePrefix = document.lineAt(position).text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    // After "id: " suggest dna:// prefix
    if (/^\s*id:\s*$/.test(linePrefix)) {
      const item = new vscode.CompletionItem('dna://', vscode.CompletionItemKind.Value);
      item.insertText = new vscode.SnippetString('dna://${1|agent,realm,philosophy,convention,protocol,flow,tool,repo,host,project,site,skill|}/${2:name}');
      item.documentation = 'DNA canonical URI';
      items.push(item);
    }

    // After "type: " suggest types
    if (/^\s*type:\s*$/.test(linePrefix)) {
      const types = ['agent', 'realm', 'philosophy', 'convention', 'protocol', 'flow', 'tool', 'repo', 'host', 'project', 'site', 'skill', 'middleware', 'maintained-oss'];
      for (const t of types) {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.EnumMember);
        item.documentation = `DNA node type: ${t}`;
        items.push(item);
      }
    }

    // After "- dna://" in links suggest format
    if (/dna:\/\/$/.test(linePrefix)) {
      const types = ['agent', 'realm', 'philosophy', 'convention', 'protocol', 'flow', 'tool', 'repo', 'host', 'project', 'site', 'skill'];
      for (const t of types) {
        const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.Reference);
        item.insertText = new vscode.SnippetString(`${t}/\${1:name}`);
        item.documentation = `Link to a ${t} node`;
        items.push(item);
      }
    }

    // After "status: " suggest statuses
    if (/^\s*status:\s*$/.test(linePrefix)) {
      for (const s of ['active', 'deprecated', 'draft', 'archived']) {
        items.push(new vscode.CompletionItem(s, vscode.CompletionItemKind.EnumMember));
      }
    }

    return items;
  }
}

// ── Auto-detect and set language mode ───────────────────────────────

function setDnaLanguageMode(document: vscode.TextDocument) {
  if (!document.fileName.endsWith('.dna')) return;
  // We keep it as 'dna' language — the TextMate grammar handles both modes
  // via the frontmatter detection pattern
}

// ── Activation ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'dna', scheme: '*' };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(selector, new DnaDocumentLinkProvider()),
    vscode.languages.registerHoverProvider(selector, new DnaHoverProvider()),
    vscode.languages.registerDefinitionProvider(selector, new DnaDefinitionProvider()),
    vscode.languages.registerCompletionItemProvider(selector, new DnaCompletionProvider(), ':', '/'),
  );

  // Set language for already-open .dna files
  vscode.workspace.textDocuments.forEach(setDnaLanguageMode);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(setDnaLanguageMode),
  );

  console.log('🧬 DNA extension activated');
}

export function deactivate() {}
