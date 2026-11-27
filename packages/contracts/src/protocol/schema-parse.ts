import type { z } from 'zod';

/** The first validation issue as one line an operator can act on: where, then what. */
export function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return `${issue?.path.map(String).join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`;
}

/** A parse that says why it refused in one line instead of throwing. */
export type SchemaParse<T> = (value: unknown) => { ok: true; value: T } | { ok: false; detail: string };

/**
 * Validate with a schema and report its first issue.
 *
 * The one place a file's refusal reason is written, so every reader of the same schema — the node
 * agent, the CLI, an owner's own tooling — says the same words for the same mistake.
 */
export function schemaParse<Schema extends z.ZodType>(schema: Schema): SchemaParse<z.output<Schema>> {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, detail: firstIssue(parsed.error) };
  };
}
