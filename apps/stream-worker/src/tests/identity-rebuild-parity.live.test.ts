/**
 * identity-rebuild-parity.live.test.ts — rebuild-from-Bronze parity for the Neo4j identity graph (Phase D).
 *
 * The C-3 guarantee: replaying the SAME Bronze identifier sequence produces the SAME, correctly-stitched
 * graph (deterministic brain_id). Combined with byte-identical per-brand hashing (identity-core, shared
 * with the PG path), this is the parity that lets Neo4j replace PG as the identity store. SKIPS if Neo4j down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveDevSaltHex } from '@brain/identity-core';
import { Neo4jIdentityWriter, IdentityGraph } from '../application/Neo4jIdentityWriter.js';

const URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const USER = process.env['NEO4J_USER'] ?? 'neo4j';
const PASS = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';
const BRAND = 'eeee0000-0000-0000-0000-0000000000e5';
const salt = resolveDevSaltHex(BRAND);

let graph: IdentityGraph;
let writer: Neo4jIdentityWriter;
let up = false;

const EMAIL_A = 'rebuild-a@example.com';
const PHONE_1 = '+919000000001';
const EMAIL_D = 'rebuild-d@example.com';

/** Purge + replay a fixed identifier sequence, then snapshot the final brain_id per identifier. */
async function replayAndSnapshot(): Promise<{ a: string | null; p: string | null; d: string | null }> {
  await graph.purgeBrand(BRAND);
  // The Bronze sequence: A (email), B (phone), C (email+phone → merges A&B), D (other email).
  await writer.resolveFromProperties(BRAND, { email: EMAIL_A }, salt, 'IN');
  await writer.resolveFromProperties(BRAND, { phone: PHONE_1 }, salt, 'IN');
  await writer.resolveFromProperties(BRAND, { email: EMAIL_A, phone: PHONE_1 }, salt, 'IN');
  await writer.resolveFromProperties(BRAND, { email: EMAIL_D }, salt, 'IN');
  // Snapshot (idempotent re-resolve returns the current brain_id).
  return {
    a: (await writer.resolveFromProperties(BRAND, { email: EMAIL_A }, salt, 'IN')).brainId,
    p: (await writer.resolveFromProperties(BRAND, { phone: PHONE_1 }, salt, 'IN')).brainId,
    d: (await writer.resolveFromProperties(BRAND, { email: EMAIL_D }, salt, 'IN')).brainId,
  };
}

beforeAll(async () => {
  graph = new IdentityGraph(URI, USER, PASS);
  try {
    await graph.verifyConnectivity();
    up = true;
  } catch {
    up = false;
    return;
  }
  await graph.bootstrap();
  writer = new Neo4jIdentityWriter(graph);
});

afterAll(async () => {
  if (graph) await graph.close();
});

describe('Neo4j identity — rebuild-from-Bronze parity', () => {
  it('stitches correctly and is deterministic across a full replay (C-3)', async () => {
    if (!up) return;
    const run1 = await replayAndSnapshot();
    // Correct stitching: email-A and phone-1 merged (via the combined event); email-D is separate.
    expect(run1.a).toBeTruthy();
    expect(run1.a).toBe(run1.p);
    expect(run1.d).not.toBe(run1.a);

    // Rebuild determinism: a full purge + identical replay yields identical brain_id assignments.
    const run2 = await replayAndSnapshot();
    expect(run2).toEqual(run1);
  });
});
