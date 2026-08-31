import matter from 'gray-matter';

export type FrontmatterDocument = {
  data: Record<string, unknown>;
  content: string;
  hasFrontmatter: boolean;
};

// Mirrors OpenCode's ConfigMarkdownCore.sanitize compatibility behavior.
// The YAML parser remains gray-matter/js-yaml; this only rewrites a narrow
// class of otherwise-invalid top-level plain scalar values before retrying.
export function sanitizeOpenCodeFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const frontmatter = match[1]!;
  const result = frontmatter.split(/\r?\n/).flatMap(line => {
    if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];

    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!entry) return [line];

    const value = entry[2]!.trim();
    if (
      value === ''
      || value === '>'
      || value === '|'
      || value.startsWith('"')
      || value.startsWith("'")
    ) {
      return [line];
    }
    if (!value.includes(':')) return [line];

    return [`${entry[1]}: |-`, `  ${value}`];
  });

  return content.replace(frontmatter, () => result.join('\n'));
}

export function parseFrontmatter(content: string): FrontmatterDocument {
  let parsed;
  try {
    parsed = matter(content);
  } catch {
    parsed = matter(sanitizeOpenCodeFrontmatter(content));
  }

  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : {};

  return {
    data,
    content: parsed.content,
    hasFrontmatter: matter.test(content),
  };
}
