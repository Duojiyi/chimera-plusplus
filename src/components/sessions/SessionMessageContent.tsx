import type { ReactNode } from "react";
import { highlightText } from "./utils";

type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string };

const FENCE_OPEN = /^(`{3,}|~{3,})\s*([^\s`]*)/;
const INLINE_CODE = /(`{1,2})([^`\n]+?)\1/g;

/**
 * Split a message into prose and fenced code blocks. Only fences are
 * recognised: transcripts are shown as written, and turning arbitrary
 * Markdown into markup would change what the user typed. An unclosed fence
 * (a collapsed preview cuts messages short) runs to the end.
 */
export function splitFencedBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  let language = "";

  const flushProse = () => {
    // Blank lines around a code block are spacing the block already has.
    const text = prose.join("\n").replace(/^(\s*\n)+|(\n\s*)+$/g, "");
    if (text.trim()) {
      blocks.push({ kind: "text", text });
    }
    prose = [];
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (code === null) {
      const open = indent <= 3 ? FENCE_OPEN.exec(trimmed) : null;
      if (open) {
        flushProse();
        code = [];
        fence = open[1];
        language = open[2];
      } else {
        prose.push(line);
      }
      continue;
    }
    const closes =
      indent <= 3 &&
      trimmed.startsWith(fence) &&
      trimmed
        .replace(/\s+$/, "")
        .split("")
        .every((char) => char === fence[0]);
    if (closes) {
      blocks.push({ kind: "code", text: code.join("\n"), language });
      code = null;
    } else {
      code.push(line);
    }
  }
  if (code !== null) {
    blocks.push({ kind: "code", text: code.join("\n"), language });
  }
  flushProse();
  return blocks;
}

function renderInlineCode(text: string, searchQuery?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0;
    if (start > last) {
      nodes.push(highlightText(text.slice(last, start), searchQuery ?? ""));
    }
    nodes.push(
      <code key={start} className="session-inline-code">
        {highlightText(match[2], searchQuery ?? "")}
      </code>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) {
    nodes.push(highlightText(text.slice(last), searchQuery ?? ""));
  }
  return nodes;
}

interface SessionMessageContentProps {
  content: string;
  /** Machine output (tool results) is shown as one monospace block. */
  monospace?: boolean;
  searchQuery?: string;
}

/** Message text with code spans and fenced blocks set in the mono face. */
export function SessionMessageContent({
  content,
  monospace = false,
  searchQuery,
}: SessionMessageContentProps) {
  if (monospace) {
    return (
      <pre className="session-code-block session-tool-output">
        {highlightText(content, searchQuery ?? "")}
      </pre>
    );
  }
  return (
    <div className="session-message-body">
      {splitFencedBlocks(content).map((block, index) =>
        block.kind === "code" ? (
          <pre
            key={index}
            className="session-code-block"
            data-language={block.language || undefined}
          >
            <code>{highlightText(block.text, searchQuery ?? "")}</code>
          </pre>
        ) : (
          <p key={index} className="session-message-prose">
            {renderInlineCode(block.text, searchQuery)}
          </p>
        ),
      )}
    </div>
  );
}
