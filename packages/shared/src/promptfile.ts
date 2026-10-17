import { PromptFrontmatter, PROMPT_KEY_ORDER } from './schema.ts';
import { splitFrontmatter, serializeFrontmatter } from './frontmatter.ts';
import { trimLineEnds } from './textScan.ts';

export interface PromptFile { frontmatter: PromptFrontmatter; body: string }

export function parsePromptFile(text: string): PromptFile {
  const { data, body } = splitFrontmatter(text);
  const parsed = PromptFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid prompt frontmatter: ${issues}`);
  }
  return { frontmatter: parsed.data, body: body.replace(/^\n+/, '').trimEnd() };
}

export function serializePromptFile(file: PromptFile): string {
  const fm = serializeFrontmatter(file.frontmatter as Record<string, unknown>, PROMPT_KEY_ORDER);
  const body = trimLineEnds(file.body).trimEnd();
  return `${fm}\n${body}\n`;
}
