import { z } from 'zod';

/**
 * Structured outputs the agents must produce. Every property is required and nullable rather than
 * optional so the generated JSON Schema satisfies strict-mode consumers (all required,
 * additionalProperties false).
 */

export const fileActionSchema = z.enum(['edited', 'created', 'deleted', 'take_upstream', 'take_patch']);
export type FileAction = z.infer<typeof fileActionSchema>;

export const resolveReportSchema = z
  .object({
    status: z.enum(['resolved', 'skip_patch', 'need_help']),
    summary: z.string(),
    files: z.array(
      z
        .object({
          path: z.string(),
          action: fileActionSchema,
          rationale: z.string(),
        })
        .strict(),
    ),
    confidence: z.enum(['high', 'medium', 'low']),
    risks: z.array(z.string()),
    notes_for_reviewer: z.string(),
  })
  .strict();
export type ResolveReport = z.infer<typeof resolveReportSchema>;

export const selfCheckSchema = z
  .object({
    complete: z.boolean(),
    concerns: z.array(
      z
        .object({
          file: z.string().nullable(),
          patch: z.string().nullable(),
          description: z.string(),
        })
        .strict(),
    ),
    summary: z.string(),
  })
  .strict();
export type SelfCheck = z.infer<typeof selfCheckSchema>;

export const severitySchema = z.enum(['blocker', 'major', 'minor']);

export const reviewVerdictSchema = z
  .object({
    verdict: z.enum(['approve', 'reject']),
    summary: z.string(),
    issues: z.array(
      z
        .object({
          id: z.string(),
          severity: severitySchema,
          patch: z.string().nullable(),
          file: z.string().nullable(),
          description: z.string(),
          suggested_fix: z.string().nullable(),
        })
        .strict(),
    ),
    skips_approved: z.array(
      z
        .object({
          patch: z.string(),
          approved: z.boolean(),
          reason: z.string(),
        })
        .strict(),
    ),
    checked: z
      .object({
        range_diff: z.boolean(),
        verify_log: z.boolean(),
        commands_run: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export const respondReportSchema = z
  .object({
    verdict: z.enum(['approve', 'reject']),
    responses: z.array(
      z
        .object({
          issue_id: z.string(),
          action: z.enum(['fixed', 'rebutted', 'deferred']),
          explanation: z.string(),
          target_patch: z.string().nullable(),
        })
        .strict(),
    ),
    files_changed: z.array(z.string()),
    summary: z.string(),
  })
  .strict();
export type RespondReport = z.infer<typeof respondReportSchema>;

export type SchemaName = 'resolve' | 'selfcheck' | 'review' | 'respond';

export const SCHEMAS = {
  resolve: resolveReportSchema,
  selfcheck: selfCheckSchema,
  review: reviewVerdictSchema,
  respond: respondReportSchema,
} as const;

/** JSON Schema in the strict dialect: every property required, no additional properties. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
