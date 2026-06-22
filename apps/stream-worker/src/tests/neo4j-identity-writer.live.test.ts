/**
 * neo4j-identity-writer.live.test.ts — Neo4jIdentityWriter against live Neo4j (Phase D tail).
 *
 * Proves the Bronze-event → extract+hash (identity-core) → graph resolve (identity-graph) path:
 * minting a brain_id from an event's identifiers, and linking a later same-email event to the same
 * brain_id (deterministic hashing). SKIPS if Neo4j is down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveDevSaltHex } from '@brain/identity-core';
import { Neo4jIdentityWriter, IdentityGraph } from '../application/Neo4jIdentityWriter.js';

const URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const USER = process.env['NEO4J_USER'] ?? 'neo4j';
const PASS = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';
const BRAND = 'dddd0000-0000-0000-0000-0000000000d4';
const salt = resolveDevSaltHex(BRAND);

let graph: IdentityGraph;
let writer: Neo4jIdentityWriter;
let up = false;

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
  await graph.purgeBrand(BRAND);
  writer = new Neo4jIdentityWriter(graph);
});

afterAll(async () => {
  if (graph) await graph.close();
});

describe('Neo4jIdentityWriter — Bronze event → graph brain_id', () => {
  it('mints a brain_id from an event with email+phone+customer_id', async () => {
    if (!up) return;
    const r = await writer.resolveFromProperties(
      BRAND,
      { email: 'shopper@example.com', phone: '+919876543210', customer_id: 'cust-1' },
      salt,
      'IN',
    );
    expect(r.outcome).toBe('minted');
    expect(r.brainId).toBeTruthy();
  });

  it('links a later same-email event to the same brain_id (deterministic hashing)', async () => {
    if (!up) return;
    const first = await writer.resolveFromProperties(BRAND, { email: 'shopper@example.com' }, salt, 'IN');
    const again = await writer.resolveFromProperties(BRAND, { email: 'shopper@example.com' }, salt, 'IN');
    expect(again.brainId).toBe(first.brainId);
  });

  it('a different email mints a different customer; an event with no identifiers is skipped', async () => {
    if (!up) return;
    const other = await writer.resolveFromProperties(BRAND, { email: 'someone-else@example.com' }, salt, 'IN');
    const base = await writer.resolveFromProperties(BRAND, { email: 'shopper@example.com' }, salt, 'IN');
    expect(other.brainId).not.toBe(base.brainId);
    const empty = await writer.resolveFromProperties(BRAND, { page_url: '/x' }, salt, 'IN');
    expect(empty.outcome).toBe('skipped');
    expect(empty.brainId).toBeNull();
  });
});
