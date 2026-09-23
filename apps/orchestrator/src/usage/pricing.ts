import { randomUUID } from 'node:crypto';
import type { PricingInput, PricingVersion } from '@acc/shared';
import type { Db } from '../db/database.js';
import { perMillionToNanos } from './cost.js';

type Row = Record<string, any>;

function toVersion(r: Row): PricingVersion {
  return {
    id: r.id,
    provider: r.provider,
    providerModelId: r.provider_model_id,
    inputNanos: r.input_nanos,
    outputNanos: r.output_nanos,
    cacheReadNanos: r.cache_read_nanos,
    cacheWriteNanos: r.cache_write_nanos,
    cacheWrite1hNanos: r.cache_write_1h_nanos,
    currency: 'USD',
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    source: r.source,
    verification: r.verification,
    lastVerifiedAt: r.last_verified_at,
    createdAt: r.created_at,
  };
}

export class PricingError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Versioned price list. A price applies from `effectiveFrom` until the next
 * version of the same model starts, so an attempt is always costed at the
 * price in force when it ran and a new price never rewrites history.
 */
export class PricingRegistry {
  constructor(private readonly db: Db) {}

  list(): PricingVersion[] {
    return (this.db.prepare('SELECT * FROM pricing_versions ORDER BY provider, provider_model_id, effective_from DESC').all() as Row[]).map(toVersion);
  }

  /** The version in force for a model at a moment, or null when the model has no price. */
  lookup(provider: string, model: string, at: string): PricingVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pricing_versions
         WHERE provider = ? AND provider_model_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(provider, model, at, at) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  get(id: string): PricingVersion | null {
    const row = this.db.prepare('SELECT * FROM pricing_versions WHERE id = ?').get(id) as Row | undefined;
    return row ? toVersion(row) : null;
  }

  /**
   * Add a price version. The open version of the same model is closed where
   * the new one begins; a version may not start before the latest existing
   * one (that would rewrite a period already costed).
   */
  add(input: PricingInput): PricingVersion {
    const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      const latest = this.db
        .prepare('SELECT * FROM pricing_versions WHERE provider = ? AND provider_model_id = ? ORDER BY effective_from DESC LIMIT 1')
        .get(input.provider, input.providerModelId) as Row | undefined;
      if (latest && latest.effective_from >= effectiveFrom) {
        throw new PricingError('INVALID', `A price for ${input.providerModelId} already starts at ${latest.effective_from}; a new version must start after it.`);
      }
      if (latest) this.db.prepare('UPDATE pricing_versions SET effective_to = ? WHERE id = ?').run(effectiveFrom, latest.id);
      this.db
        .prepare(
          `INSERT INTO pricing_versions (id, provider, provider_model_id, input_nanos, output_nanos, cache_read_nanos, cache_write_nanos, cache_write_1h_nanos,
             effective_from, source, verification, last_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.provider,
          input.providerModelId,
          perMillionToNanos(input.inputPerMillion),
          perMillionToNanos(input.outputPerMillion),
          input.cacheReadPerMillion === null ? null : perMillionToNanos(input.cacheReadPerMillion),
          input.cacheWritePerMillion === null ? null : perMillionToNanos(input.cacheWritePerMillion),
          input.cacheWrite1hPerMillion === null ? null : perMillionToNanos(input.cacheWrite1hPerMillion),
          effectiveFrom,
          input.source,
          input.verification,
          input.verification === 'unverified' ? null : createdAt,
          createdAt,
        );
    })();
    return this.get(id)!;
  }
}
