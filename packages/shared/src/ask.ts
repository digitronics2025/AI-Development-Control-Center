import { z } from 'zod';
import { agentIdSchema, effortSchema, modelIdSchema } from './schemas.js';

/**
 * Ask: a read-only chat outside tasks (docs/systems/ask.md). A question
 * never creates a task, never edits a file and never reaches a tool bridge;
 * anything that needs a change becomes a task through New Task.
 */

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
  createdAt: string;
  updatedAt: string;
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
});

export const askThreadUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the conversation a name').max(120),
    repositoryId: z.string().min(1).max(100).nullable(),
    agentId: agentIdSchema,
    model: modelIdSchema,
    effort: effortSchema,
  })
  .partial();

export const askMessageBodySchema = z.object({
  text: z.string().trim().min(1, 'Write a question').max(4000),
  clientMessageId: z.string().min(8).max(100),
});
