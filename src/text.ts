/** The supported input syntax: HTTP(S) Markdown links and standalone ## thread breaks. */
export type TextToken =
  | { kind: "text" | "literal" | "break"; source: string }
  | { kind: "link"; source: string; label: string; url: string };

export interface TextLink {
  start: number;
  end: number;
  url: string;
}

export function isWebUrl(value: string): boolean {
  if (/[\s<>\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]()<>#:])/g, "$1");
}

function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function readLink(text: string, start: number): Extract<TextToken, { kind: "link" }> | undefined {
  const labelEnd = closing(text, start, "[", "]");
  if (labelEnd < 0) return;
  const open = labelEnd + (text[labelEnd + 1] === "\\" ? 2 : 1);
  if (text[open] !== "(") return;
  const end = closing(text, open, "(", ")");
  if (end < 0) return;
  let target = text.slice(open + 1, end).trim();
  // Accept pasted editor links such as [label]\([https://url](https://url)).
  if (target.startsWith("[")) {
    const nested = readLink(target, 0);
    if (!nested || nested.source.length !== target.length) return;
    target = nested.url;
  } else {
    const destination = /^(<[^<>\n]+>|\S+?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?$/u.exec(target)?.[1];
    if (!destination) return;
    target = destination.startsWith("<") ? destination.slice(1, -1) : destination;
  }
  const url = unescapeMarkdown(target);
  const label = unescapeMarkdown(text.slice(start + 1, labelEnd));
  if (!label.trim() || /[\r\n]/u.test(label) || !isWebUrl(url)) return;
  return { kind: "link", source: text.slice(start, end + 1), label, url };
}

export function tokenizeText(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  // Keep code, existing Org links, escaped punctuation and bare URLs literal.
  const protectedText = /(?:^|(?<=\n))[ \t]*(?:`{3,}[^\n]*\n[\s\S]*?(?:\n[ \t]*`{3,}[^\n]*(?=\n|$)|(?![\s\S]))|~{3,}[^\n]*\n[\s\S]*?(?:\n[ \t]*~{3,}[^\n]*(?=\n|$)|(?![\s\S]))|#\+begin_(src|example)\b[^\n]*\n[\s\S]*?^#\+end_\1\b[^\n]*)|(`+)[^`\n]*?\2(?!`)|\[\[[^\n]*?\]\]|https?:\/\/[^\s<>]+|\\[\\[\]()#]/gimy;
  let plainStart = 0;
  const flush = (end: number) => {
    if (end > plainStart) tokens.push({ kind: "text", source: text.slice(plainStart, end) });
  };
  for (let i = 0; i < text.length;) {
    protectedText.lastIndex = i;
    const literal = protectedText.exec(text)?.[0];
    let token: TextToken | undefined = literal ? { kind: "literal", source: literal } : undefined;
    if (!token && (text[i] === "[" || text.slice(i, i + 2) === "![")) {
      const image = text[i] === "!";
      const link = readLink(text, i + (image ? 1 : 0));
      if (link) token = image ? { kind: "literal", source: `!${link.source}` } : link;
    }
    if (!token && text.slice(i, i + 2) === "##" &&
      (i === 0 || /\s/u.test(text[i - 1]!)) && (i + 2 === text.length || /\s/u.test(text[i + 2]!))) {
      token = { kind: "break", source: "##" };
    }
    if (!token) { i++; continue; }
    flush(i);
    tokens.push(token);
    i += token.source.length;
    plainStart = i;
  }
  flush(text.length);
  return tokens;
}

function markdownLink(token: Extract<TextToken, { kind: "link" }>): string {
  const label = token.label.replace(/[\\[\]]/g, "\\$&");
  const url = token.url.replace(/[\\()]/g, "\\$&");
  return `[${label}](${url})`;
}

/** Render links for a destination, retaining breaks until the thread plan is built. */
export function threadSource(text: string, nativeLinks: boolean): string {
  return tokenizeText(text).map(token => token.kind === "link"
    ? nativeLinks ? markdownLink(token) : token.label === token.url ? token.url : `${token.label} (${token.url})`
    : token.source).join("");
}

export function textSections(text: string): string[] {
  const sections = [""];
  for (const token of tokenizeText(text)) {
    if (token.kind === "break") sections.push("");
    else sections[sections.length - 1] += token.source;
  }
  return sections.map(section => section.trim()).filter(Boolean);
}

export function completeMarkdown(text: string): string {
  return textSections(threadSource(text, true)).join("\n\n");
}

export function linkedText(text: string, fallback = false): { text: string; links: TextLink[] } {
  let result = "";
  const links: TextLink[] = [];
  for (const token of tokenizeText(text)) {
    if (token.kind === "link") {
      const start = result.length;
      result += token.label;
      links.push({ start, end: result.length, url: token.url });
      if (fallback && token.label !== token.url) result += ` (${token.url})`;
    } else result += token.kind === "break" ? "\n\n" : token.source;
  }
  return { text: result, links };
}

/** Number links once for the complete draft; its reference list ends the thread. */
export function referencedText(text: string, preserveBreaks = false): string {
  const references = new Map<string, number>();
  const sections = textSections(text).map(section => tokenizeText(section).map(token => {
    if (token.kind !== "link") return token.source;
    let index = references.get(token.url);
    if (index === undefined) {
      index = references.size;
      references.set(token.url, index);
    }
    return `${token.label} [${index}]`;
  }).join(""));
  const body = sections.join(preserveBreaks ? "\n\n##\n\n" : "\n\n");
  const footer = [...references].map(([url, index]) => `[${index}]${url}`).join("\n");
  return footer ? `${body}\n\n${footer}` : body;
}

export function htmlText(text: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return tokenizeText(completeMarkdown(text)).map(token => token.kind === "link"
    ? `<a href="${escape(token.url)}">${escape(token.label)}</a>` : escape(token.source)).join("");
}
