/**
 * argo-erasure-submitter.unit.test.ts — unit tests for the AUD-OPS-037 Bronze raw-PII
 * erasure submit adapter (ArgoErasureWorkflowSubmitter).
 *
 * NO live Argo/Kubernetes required: the request-builder is a pure function, and the HTTP
 * behavior is proven against an in-process node:http server (success / non-2xx / unreachable).
 *
 * PROVES:
 *   1. k8s mode builds a Workflow CR create (workflowTemplateRef + arguments.parameters)
 *      against /apis/argoproj.io/v1alpha1/namespaces/{ns}/workflows.
 *   2. argo-server mode builds POST /api/v1/workflows/{ns}/submit with
 *      resourceKind=WorkflowTemplate + submitOptions.parameters.
 *   3. Parameter names match the WorkflowTemplate contract exactly
 *      (brand-id / identifier-hash / anon-ids / device-ids ← erasure_raw_delete.py env contract).
 *   4. Raw anon/device ids are sanitized (unsafe charset dropped, de-duped) BEFORE comma-joining,
 *      so the env round-trips losslessly.
 *   5. FAIL-SAFE: non-2xx and unreachable-endpoint submits THROW BronzeRawErasureSubmitError
 *      (retryable) — a submit can never silently succeed.
 *   6. Success returns the created workflow's generated name; the bearer token is sent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  ArgoErasureWorkflowSubmitter,
  BronzeRawErasureSubmitError,
  buildSubmitRequest,
} from '../infrastructure/argo/ArgoErasureWorkflowSubmitter.js';

const BRAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'ab'.repeat(32); // 64-hex

const SUBMISSION = {
  brandId: BRAND,
  identifierHash: HASH,
  anonIds: ['anon-1', 'anon-2'],
  deviceIds: ['dev-1'],
};

// ── 1-4: pure request builder ────────────────────────────────────────────────

describe('buildSubmitRequest — k8s mode (Workflow CR create)', () => {
  const { path, body } = buildSubmitRequest(
    { mode: 'k8s', namespace: 'argo', templateName: 'bronze-raw-erasure' },
    SUBMISSION,
  );

  it('targets the argoproj.io workflows collection in the template namespace', () => {
    expect(path).toBe('/apis/argoproj.io/v1alpha1/namespaces/argo/workflows');
  });

  it('references the WorkflowTemplate (workflowTemplateRef) with a generateName', () => {
    const spec = body['spec'] as Record<string, unknown>;
    expect(spec['workflowTemplateRef']).toEqual({ name: 'bronze-raw-erasure' });
    const metadata = body['metadata'] as Record<string, unknown>;
    expect(metadata['generateName']).toBe('bronze-raw-erasure-');
  });

  it('carries the exact parameter names of the WorkflowTemplate contract', () => {
    const spec = body['spec'] as { arguments: { parameters: Array<{ name: string; value: string }> } };
    expect(spec.arguments.parameters).toEqual([
      { name: 'brand-id', value: BRAND },
      { name: 'identifier-hash', value: HASH },
      { name: 'anon-ids', value: 'anon-1,anon-2' },
      { name: 'device-ids', value: 'dev-1' },
    ]);
  });

  it('labels the workflow with the tenant brand id (ops traceability), never the subject hash', () => {
    const labels = (body['metadata'] as { labels: Record<string, string> }).labels;
    expect(labels['brain.io/brand-id']).toBe(BRAND);
    expect(Object.values(labels)).not.toContain(HASH);
  });
});

describe('buildSubmitRequest — argo-server mode (REST submit)', () => {
  const { path, body } = buildSubmitRequest(
    { mode: 'argo-server', namespace: 'argo', templateName: 'bronze-raw-erasure' },
    SUBMISSION,
  );

  it('targets the Argo server submit endpoint', () => {
    expect(path).toBe('/api/v1/workflows/argo/submit');
  });

  it('submits from the WorkflowTemplate with name=value parameters', () => {
    expect(body['resourceKind']).toBe('WorkflowTemplate');
    expect(body['resourceName']).toBe('bronze-raw-erasure');
    const opts = body['submitOptions'] as { parameters: string[] };
    expect(opts.parameters).toEqual([
      `brand-id=${BRAND}`,
      `identifier-hash=${HASH}`,
      'anon-ids=anon-1,anon-2',
      'device-ids=dev-1',
    ]);
  });
});

describe('buildSubmitRequest — raw-id sanitization (mirrors erasure_raw_delete.py _RAW_ID_RE)', () => {
  it('drops unsafe / empty values and de-dupes, so the comma-join round-trips losslessly', () => {
    const { body } = buildSubmitRequest(
      { mode: 'k8s', namespace: 'argo', templateName: 'bronze-raw-erasure' },
      {
        ...SUBMISSION,
        anonIds: ['ok-1', 'ok-1', "bad'quote", 'has,comma', '  ', 'ok-2'],
        deviceIds: ['white space'],
      },
    );
    const params = (body['spec'] as { arguments: { parameters: Array<{ name: string; value: string }> } })
      .arguments.parameters;
    expect(params.find((p) => p.name === 'anon-ids')?.value).toBe('ok-1,ok-2');
    expect(params.find((p) => p.name === 'device-ids')?.value).toBe('');
  });
});

// ── 5-6: HTTP behavior against an in-process server ─────────────────────────

describe('ArgoErasureWorkflowSubmitter — HTTP behavior (in-process server)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      server.close();
      server = undefined;
    }
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const srv = createServer(handler);
    server = srv;
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    if (addr == null || typeof addr === 'string') throw new Error('no port');
    return addr.port;
  }

  function makeSubmitter(port: number) {
    return new ArgoErasureWorkflowSubmitter({
      serverUrl: `http://127.0.0.1:${port}`,
      mode: 'k8s',
      namespace: 'argo',
      templateName: 'bronze-raw-erasure',
      authToken: 'test-token', // static token — no SA token file read in tests
      timeoutMs: 2000,
    });
  }

  it('success: returns the generated workflow name and sends the bearer token', async () => {
    let seenAuth: string | undefined;
    let seenPath: string | undefined;
    const port = await listen((req, res) => {
      seenAuth = req.headers.authorization;
      seenPath = req.url ?? '';
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ metadata: { name: 'bronze-raw-erasure-x7k2p' } }));
    });

    const result = await makeSubmitter(port).submit(SUBMISSION);
    expect(result.workflowName).toBe('bronze-raw-erasure-x7k2p');
    expect(seenAuth).toBe('Bearer test-token');
    expect(seenPath).toBe('/apis/argoproj.io/v1alpha1/namespaces/argo/workflows');
  });

  it('non-2xx (RBAC denied etc.) throws BronzeRawErasureSubmitError — never a silent success', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'Status', reason: 'Forbidden' }));
    });

    await expect(makeSubmitter(port).submit(SUBMISSION)).rejects.toThrow(BronzeRawErasureSubmitError);
    await expect(makeSubmitter(port).submit(SUBMISSION)).rejects.toThrow('HTTP 403');
  });

  it('2xx without a workflow name in the response still throws (fail-safe)', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    await expect(makeSubmitter(port).submit(SUBMISSION)).rejects.toThrow('no workflow name');
  });

  it('unreachable endpoint throws BronzeRawErasureSubmitError (retryable — consumer retry/DLQ path)', async () => {
    // Bind + close to obtain a port that is certainly not listening.
    const port = await listen(() => {});
    const srv = server!;
    server = undefined;
    await new Promise<void>((resolve, reject) =>
      srv.close((err) => (err ? reject(err) : resolve())),
    );

    await expect(makeSubmitter(port).submit(SUBMISSION)).rejects.toThrow(BronzeRawErasureSubmitError);
  });
});
