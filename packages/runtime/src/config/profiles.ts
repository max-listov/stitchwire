/** Command profiles, stream profiles and the admission limits that bound them. */

import { z } from 'zod';
import {
  MAX_ARG_BYTES,
  MAX_ARG_COUNT,
  MAX_COMMAND_CANCELLATION_GRACE_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_STDIN_BYTES,
  MAX_STREAM_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  MAX_STREAM_TOTAL_BYTES,
  MAX_STREAM_WINDOW_BYTES,
  MAX_STREAM_TIMEOUT_MS,
} from '../../../contracts/src/protocol/bounds.ts';

const EnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/)
  .max(128);

const CallerOptionNameSchema = z.string().regex(/^--[a-z][a-z0-9-]{0,31}$/);

const OpaqueCallerOptionSchema = z
  .object({
    type: z.literal('opaque'),
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    minBytes: z.number().int().min(1).max(MAX_ARG_BYTES),
    maxBytes: z.number().int().min(1).max(MAX_ARG_BYTES),
    required: z.boolean().default(false),
  })
  .strict()
  .superRefine((option, ctx) => {
    if (option.minBytes > option.maxBytes) {
      ctx.addIssue({ code: 'custom', path: ['minBytes'], message: 'minBytes must not exceed maxBytes' });
    }
    if (option.prefix !== undefined && Buffer.byteLength(option.prefix) > option.maxBytes) {
      ctx.addIssue({ code: 'custom', path: ['prefix'], message: 'prefix must fit inside maxBytes' });
    }
  });

export const IntegerCallerOptionSchema = z
  .object({
    type: z.literal('integer'),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((option) => option.min <= option.max, { path: ['min'], message: 'min must not exceed max' });

const CallerOptionSchema = z.discriminatedUnion('type', [
  OpaqueCallerOptionSchema,
  IntegerCallerOptionSchema,
]);

const CallerArgsPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('append'),
      maxCount: z.number().int().min(1).max(MAX_ARG_COUNT),
      maxBytes: z.number().int().min(1).max(MAX_ARG_BYTES),
      allowedValues: z.array(z.string().min(1).max(MAX_ARG_BYTES)).max(256).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('options'),
      options: z.record(CallerOptionNameSchema, CallerOptionSchema),
    })
    .strict()
    .refine((policy) => Object.keys(policy.options).length > 0, {
      path: ['options'],
      message: 'at least one option is required',
    })
    .refine((policy) => Object.keys(policy.options).length <= MAX_ARG_COUNT / 2, {
      path: ['options'],
      message: `at most ${MAX_ARG_COUNT / 2} options are allowed`,
    }),
]);
export type CallerArgsPolicy = z.infer<typeof CallerArgsPolicySchema>;

function callerArgsCapacity(policy: CallerArgsPolicy): { count: number; bytes: number } {
  if (policy.mode === 'none') return { count: 0, bytes: 0 };
  if (policy.mode === 'append') return { count: policy.maxCount, bytes: policy.maxBytes };
  const entries = Object.entries(policy.options);
  const count = entries.length * 2;
  const bytes = entries.reduce(
    (total, [name, option]) =>
      total +
      Buffer.byteLength(name) +
      (option.type === 'opaque' ? option.maxBytes : String(option.max).length),
    Math.max(0, count - 1),
  );
  return { count, bytes };
}

function validateProfileArgumentCapacity(
  profile: { argv: string[]; callerArgs: CallerArgsPolicy },
  ctx: z.RefinementCtx,
): void {
  const baseBytes = Buffer.byteLength(profile.argv.join('\0'));
  if (baseBytes > MAX_ARG_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['argv'], message: `base argv exceeds ${MAX_ARG_BYTES} bytes` });
  }
  const caller = callerArgsCapacity(profile.callerArgs);
  if (profile.argv.length + caller.count > MAX_ARG_COUNT) {
    ctx.addIssue({
      code: 'custom',
      path: ['callerArgs'],
      message: `base argv plus caller arguments exceeds ${MAX_ARG_COUNT} entries`,
    });
  }
  const separator = profile.argv.length > 0 && caller.count > 0 ? 1 : 0;
  if (baseBytes + separator + caller.bytes > MAX_ARG_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['callerArgs'],
      message: `base argv plus caller arguments exceeds ${MAX_ARG_BYTES} bytes`,
    });
  }
}

const StdinPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('text'), maxBytes: z.number().int().min(1).max(MAX_STDIN_BYTES) }).strict(),
]);

/**
 * What a declared execution profile is, regardless of which plane serves it.
 *
 * Command and stream profiles share execution fields and security refinements;
 * each plane owns its output bounds.
 */
const ExecutionProfileSchema = z.object({
  bin: z.string().startsWith('/'),
  argv: z.array(z.string().min(1).max(MAX_ARG_BYTES)).max(MAX_ARG_COUNT).default([]),
  callerArgs: CallerArgsPolicySchema.default({ mode: 'none' }),
  stdin: StdinPolicySchema.default({ mode: 'none' }),
  cwd: z.string().startsWith('/').optional(),
  env: z
    .object({
      inherit: z.array(EnvNameSchema).max(64).default([]),
      set: z.record(EnvNameSchema, z.string().max(16 * 1024)).default({}),
    })
    .strict()
    .default({ inherit: [], set: {} }),
  concurrency: z.number().int().min(1).max(128).default(1),
});

/** The reserved-name and argument-capacity checks both planes must pass. */
function validateExecutionProfile(
  profile: z.output<typeof ExecutionProfileSchema>,
  ctx: z.RefinementCtx,
): void {
  validateProfileArgumentCapacity(profile, ctx);
  if (profile.env.inherit.includes('STITCHWIRE_TOKEN') || profile.env.set.STITCHWIRE_TOKEN !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['env'],
      message: 'STITCHWIRE_TOKEN is reserved and cannot enter a child environment',
    });
  }
}

/**
 * How a command's answer is read.
 *
 * `raw` carries stdout bytes for the consumer to interpret. `json` validates at the node,
 * distinguishing invalid command output from transport loss.
 */
const CommandOutputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('raw') }).strict(),
  z.object({ mode: z.literal('json') }).strict(),
]);

export const CommandProfileSchema = z
  .object({
    ...ExecutionProfileSchema.shape,
    timeoutMs: z.number().int().min(1_000).max(MAX_COMMAND_TIMEOUT_MS).default(30_000),
    /** Signal only the owner process, letting it finish a child transaction before bounded fallback. */
    cancellation: z
      .strictObject({
        mode: z.literal('cooperative'),
        graceMs: z.number().int().min(1).max(MAX_COMMAND_CANCELLATION_GRACE_MS),
      })
      .optional(),
    outputBytes: z.number().int().min(1_024).max(MAX_STREAM_BYTES).default(MAX_STREAM_BYTES),
    output: CommandOutputSchema.default({ mode: 'raw' }),
  })
  .strict()
  .superRefine(validateExecutionProfile);
export type CommandProfile = z.infer<typeof CommandProfileSchema>;

const StreamFormatSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('raw') }).strict(),
  z.object({ mode: z.literal('ndjson'), stableCursor: z.boolean().default(false) }).strict(),
]);

export const StreamProfileSchema = z
  .object({
    ...ExecutionProfileSchema.shape,
    // A stream runs longer than a call by nature, and it bounds a total rather than one answer.
    timeoutMs: z.number().int().min(1_000).max(MAX_STREAM_TIMEOUT_MS).default(300_000),
    maxBytes: z
      .number()
      .int()
      .min(1_024)
      .max(MAX_STREAM_TOTAL_BYTES)
      .default(64 * 1024 * 1024),
    format: StreamFormatSchema.default({ mode: 'raw' }),
  })
  .strict()
  .superRefine((profile, ctx) => {
    validateExecutionProfile(profile, ctx);
    if (
      profile.env.inherit.includes('STITCHWIRE_STREAM_CURSOR') ||
      profile.env.set.STITCHWIRE_STREAM_CURSOR !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: 'STITCHWIRE_STREAM_CURSOR is reserved for an authenticated resume request',
      });
    }
  });
export type StreamProfile = z.infer<typeof StreamProfileSchema>;

export const NodeAdmissionSchema = z
  .object({
    maxInflight: z.number().int().min(1).max(1_024).default(32),
    maxCallsPerMinute: z.number().int().min(1).max(60_000).default(600),
    maxStreamProducers: z.number().int().min(1).max(1_024).default(16),
    maxStreamConsumers: z.number().int().min(1).max(1_024).default(8),
    maxStreamBufferedBytes: z
      .number()
      .int()
      .min(MAX_STREAM_CHUNK_BYTES)
      .max(MAX_STREAM_WINDOW_BYTES)
      .default(MAX_STREAM_WINDOW_BYTES),
    maxEventSubscriptions: z.number().int().min(1).max(1_024).default(32),
    maxEventBufferedPerSubscription: z.number().int().min(1).max(1_024).default(64),
    maxPendingPublishes: z.number().int().min(1).max(1_024).default(32),
    maxPublishesPerMinute: z.number().int().min(1).max(60_000).default(600),
    publishAckTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  })
  .strict()
  .prefault({});
