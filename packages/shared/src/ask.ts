import { z } from 'zod';
import { agentIdSchema, effortSchema, modelIdSchema } from './schemas.js';

/**
 * Ask: a read-only chat outside tasks (docs/systems/ask.md). A question
 * never creates a task, never edits a file and never reaches a tool bridge;
 * anything that needs a change becomes a task through New Task.
 */

/**
 * Where an answer may look (docs/systems/ask.md). The Control Center's own
 * records are always available; GitHub and Cloudflare need a read-only key
 * chosen in Settings → Ask.
 */
export const ASK_SOURCES = ['controlcenter', 'github', 'cloudflare'] as const;
export type AskSource = (typeof ASK_SOURCES)[number];
export const ASK_SOURCE_LABEL: Record<AskSource, string> = { controlcenter: 'Control Center', github: 'GitHub', cloudflare: 'Cloudflare' };

export const ASK_MESSAGE_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'] as const;
export type AskMessageStatus = (typeof ASK_MESSAGE_STATUSES)[number];
export type AskMessageRole = 'user' | 'assistant';

export interface AskThread {
  id: string;
  title: string;
  /** The repository the agent reads; null answers from the Control Center only. */
  repositoryId: string | null;
  agentId: string;
  model: string;
  effort: string;
  /** Sources this conversation may read. */
  sources: AskSource[];
  /** Personal data is shown unmasked in this conversation. */
  showPersonal: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One lookup an answer made, from the tool execution record. */
export interface AskLookup {
  id: string;
  capability: string;
  summary: string | null;
  status: string;
  /** Live Cloudflare data was read. */
  live: boolean;
  durationMs: number | null;
  startedAt: string;
}

export interface AskMessage {
  id: string;
  threadId: string;
  seq: number;
  role: AskMessageRole;
  body: string;
  status: AskMessageStatus;
  /** Why an answer failed, in plain words. */
  error: string | null;
  /** What an answer looked at (answers only; empty when it used no data tools). */
  lookups: AskLookup[];
  createdAt: string;
}

export interface AskThreadDetail {
  thread: AskThread;
  messages: AskMessage[];
}

export const askThreadCreateSchema = z.object({
  repositoryId: z.string().min(1).max(100).nullable().optional(),
  /** Omitted: the Ask defaults in Settings. */
  agentId: agentIdSchema.optional(),
  model: modelIdSchema.optional(),
  effort: effortSchema.optional(),
  sources: z.array(z.enum(ASK_SOURCES)).max(ASK_SOURCES.length).optional(),
  showPersonal: z.boolean().optional(),
});

export const askThreadUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the conversation a name').max(120),
    repositoryId: z.string().min(1).max(100).nullable(),
    agentId: agentIdSchema,
    model: modelIdSchema,
    effort: effortSchema,
    sources: z.array(z.enum(ASK_SOURCES)).max(ASK_SOURCES.length),
    showPersonal: z.boolean(),
  })
  .partial();

/** Result of Settings → Ask → Check access, per source. */
export interface AskSourceCheck {
  source: AskSource;
  ok: boolean;
  /** "ready", "needs setup", or what went wrong. */
  message: string;
}

export const askMessageBodySchema = z.object({
  text: z.string().trim().min(1, 'Write a question').max(4000),
  clientMessageId: z.string().min(8).max(100),
});
