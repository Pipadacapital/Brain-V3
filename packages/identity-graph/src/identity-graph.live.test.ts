/**
 * identity-graph.live.test.ts — the Neo4j identity graph, against a REAL Neo4j (Phase D).
 *
 * Proves the stitching contract end-to-end: mint → link → merge, deterministic brain_id, idempotent
 * replay, and per-brand isolation (same hash in two brands ≠ same customer). SKIPS if Neo4j is down.
 * REQUIRES: docker compose --profile core up neo4j (bolt://localhost:7687, neo4j/brain_neo4j).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j from 'neo4j-driver';
import { IdentityGraph } from './index.js';

const URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const USER = process.env['NEO4J_USER'] ?? 'neo4j';
const PASS = process.env['NEO4J_PASSWORD'] ?? 'brain_neo4j';

const BRAND_A = 'aaaa0000-0000-0000-0000-0000000000a1';
const BRAND_B = 'bbbb0000-0000-0000-0000-0000000000b2';
const h = (s: string) => s.padEnd(64, '0'); // 64-hex-ish stand-in for a salted sha256

let graph: IdentityGraph;
let up = false;

beforeAll(async () => {
  // Probe Neo4j; skip the suite if it isn't reachable.
  try {
    const probe = neo4j.driver(URI, neo4j.auth.basic(USER, PASS));
    await probe.getServerInfo();
    await probe.close();
    up = true;
  } catch {
    up = false;
    return;
  }
  graph = new IdentityGraph(URI, USER, PASS);
  await graph.bootstrap();
  // Clean test brands.
  const d = neo4j.driver(URI, neo4j.auth.basic(USER, PASS));
  const s = d.session();
  await s.run('MATCH (n) WHERE n.brand_id IN $b DETACH DELETE n', { b: [BRAND_A, BRAND_B] });
  await s.close();
  await d.close();
});

afterAll(async () => {
  if (graph) await graph.close();
});

describe('IdentityGraph — Neo4j stitching', () => {
  it('mints a new brain_id for unseen identifiers, idempotently', async () => {
    if (!up) return;
    const r1 = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('email1') }]);
    expect(r1.outcome).toBe('minted');
    expect(r1.brainId).toBeTruthy();
    // replay → same brain_id, now 'linked' (already known)
    const r2 = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('email1') }]);
    expect(r2.brainId).toBe(r1.brainId);
    expect(r2.outcome).toBe('linked');
  });

  it('links a new identifier to the existing customer', async () => {
    if (!up) return;
    const base = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('email1') }]);
    const linked = await graph.resolve(BRAND_A, [
      { type: 'email', hash: h('email1') },
      { type: 'phone', hash: h('phone1') },
    ]);
    expect(linked.brainId).toBe(base.brainId);
    // the phone alone now resolves to the same customer
    const viaPhone = await graph.resolve(BRAND_A, [{ type: 'phone', hash: h('phone1') }]);
    expect(viaPhone.brainId).toBe(base.brainId);
  });

  it('merges two customers that turn out to share an identifier', async () => {
    if (!up) return;
    const y = await graph.resolve(BRAND_A, [{ type: 'phone', hash: h('phoneM') }]);
    const z = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('emailM') }]);
    expect(y.outcome).toBe('minted');
    expect(z.outcome).toBe('minted');
    expect(y.brainId).not.toBe(z.brainId);
    const merged = await graph.resolve(BRAND_A, [
      { type: 'phone', hash: h('phoneM') },
      { type: 'email', hash: h('emailM') },
    ]);
    expect(merged.outcome).toBe('merged');
    // both original identifiers now resolve to the single canonical brain_id
    const viaPhone = await graph.resolve(BRAND_A, [{ type: 'phone', hash: h('phoneM') }]);
    const viaEmail = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('emailM') }]);
    expect(viaPhone.brainId).toBe(merged.brainId);
    expect(viaEmail.brainId).toBe(merged.brainId);
    expect([y.brainId, z.brainId]).toContain(merged.brainId); // canonical is one of the originals
  });

  it('is per-brand isolated — the same hash in another brand is a DIFFERENT customer', async () => {
    if (!up) return;
    const a = await graph.resolve(BRAND_A, [{ type: 'email', hash: h('email1') }]);
    const b = await graph.resolve(BRAND_B, [{ type: 'email', hash: h('email1') }]);
    expect(b.outcome).toBe('minted'); // brand B has never seen it
    expect(b.brainId).not.toBe(a.brainId); // no cross-brand stitching (P0)
  });
});
