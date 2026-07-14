/**
 * ArgoErasureWorkflowSubmitter — submits the `bronze-raw-erasure` Argo WorkflowTemplate
 * (infra/helm/cronworkflows/templates/spark-erasure.yaml) that wraps
 * db/iceberg/spark/erasure_raw_delete.py, the Bronze raw-PII subject hard-delete
 * (AUD-OPS-037 / I-S05 / D4).
 *
 * This is the LIVE implementation behind the erasure orchestrator's STEP 4 — the step that was
 * previously the registered-DISABLED shredIcebergSnapshots seam (which stays in place as the
 * honest not-configured fallback; see EraseSubjectUseCase).
 *
 * TWO SUBMIT MODES (one env: ARGO_SUBMIT_MODE):
 *
 *   'k8s' (DEFAULT — matches prod): the prod argo-workflows app runs CONTROLLER-ONLY
 *     (server.enabled=false in infra/argocd/envs/prod/argo-workflows.yaml) — there is NO Argo
 *     REST server. Submission is a plain Kubernetes-API create of a Workflow CR with
 *     workflowTemplateRef (exactly what `argo submit --from workflowtemplate/...` does):
 *       POST {ARGO_SERVER_URL}/apis/argoproj.io/v1alpha1/namespaces/{ns}/workflows
 *     Auth = the pod's projected ServiceAccount token (read fresh per submit — erasures are rare
 *     and the projected token rotates), TLS = the cluster CA bundle from the same mount. RBAC:
 *     the cronworkflows chart binds Role bronze-raw-erasure-submitter (create+get workflows in
 *     ns argo) to the stream-worker ServiceAccount.
 *
 *   'argo-server': for a cluster that DOES run the Argo server (or a port-forward in dev):
 *       POST {ARGO_SERVER_URL}/api/v1/workflows/{ns}/submit
 *     with resourceKind=WorkflowTemplate + submitOptions.parameters. Bearer = ARGO_TOKEN.
 *
 * FAIL-SAFE (never silently succeed): ANY failure — unreachable endpoint, timeout, non-2xx,
 * unparseable response — throws BronzeRawErasureSubmitError. The caller (EraseSubjectUseCase)
 * lets it propagate, so the consumer does NOT commit the offset and the message retries → DLQ
 * after MAX_RETRY. An erasure whose Bronze-raw sweep was never submitted is NEVER marked complete.
 *
 * NO RAW PII: parameters carry only the brand UUID, the 64-hex subject hash, and the RAW
 * anon/device ids (client-generated tokens, not direct identifiers) — the same values the Spark
 * job's own contract requires. Nothing else leaves the process; logs stay hash-prefix-only
 * (the caller logs, this class does not log parameter values).
 *
 * Uses node:https/node:http directly (NOT global fetch): the k8s mode must trust the CLUSTER CA
 * (/var/run/secrets/kubernetes.io/serviceaccount/ca.crt), which undici's fetch cannot be handed
 * per-call without an extra dependency. Zero new deps.
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// ── Port (consumed by EraseSubjectUseCase) ────────────────────────────────────

export interface BronzeRawErasureSubmission {
  /** Tenant isolation key — ALWAYS the first DELETE predicate in the Spark job. */
  brandId: string;
  /** 64-hex per-brand-salted SHA-256 of the subject's email/phone (the identity-graph hash). */
  identifierHash: string;
  /** RAW (un-hashed) brain_anon_ids for the payload-path sweep (may be empty). */
  anonIds: string[];
  /** RAW (un-hashed) device_ids for the payload-path sweep (may be empty). */
  deviceIds: string[];
}

export interface IBronzeRawErasureSubmitter {
  /** Submit the Bronze-raw erasure workflow. Resolves with the created workflow's name; THROWS on any failure (retryable). */
  submit(submission: BronzeRawErasureSubmission): Promise<{ workflowName: string }>;
}

/**
 * Retryable submit failure: Argo/k8s unreachable, timeout, auth/RBAC rejection, non-2xx.
 * The consumer retry/DLQ discipline treats it like any other write error — the offset is
 * NOT committed and the erasure is NOT marked complete.
 */
export class BronzeRawErasureSubmitError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(`[bronze-raw-erasure] submit failed (retryable): ${message}`);
    this.name = 'BronzeRawErasureSubmitError';
  }
}

// ── Options ───────────────────────────────────────────────────────────────────

export type ArgoSubmitMode = 'k8s' | 'argo-server';

export interface ArgoErasureWorkflowSubmitterOptions {
  /** Base URL: https://kubernetes.default.svc (k8s mode) or the Argo server origin (argo-server mode). */
  serverUrl: string;
  mode: ArgoSubmitMode;
  /** Namespace the WorkflowTemplate lives in (the cronworkflows chart's destination — 'argo'). */
  namespace: string;
  /** WorkflowTemplate name ('bronze-raw-erasure'). */
  templateName: string;
  /** Static bearer token. Unset in k8s mode → the projected SA token file is read per submit. */
  authToken?: string;
  /** Override for the projected SA token path (tests). */
  tokenFile?: string;
  /** Override for the cluster CA bundle path (tests). Unset + file absent → system CAs. */
  caFile?: string;
  /** Whole-request timeout. */
  timeoutMs: number;
}

const K8S_SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

// The Spark job's fail-safe raw-id charset (erasure_raw_delete.py _RAW_ID_RE). Values outside it
// would be dropped in-job with a WARN anyway; filtering here also guarantees the comma-joined
// ANON_IDS/DEVICE_IDS env can be split back losslessly (no embedded commas/whitespace).
const RAW_ID_RE = /^[A-Za-z0-9._:@/-]{1,256}$/;

function sanitizeRawIds(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && RAW_ID_RE.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Pure request builder (exported for unit tests): (options, submission) → { path, body }.
 * Parameter names match the WorkflowTemplate's spec.arguments.parameters exactly.
 */
export function buildSubmitRequest(
  opts: Pick<ArgoErasureWorkflowSubmitterOptions, 'mode' | 'namespace' | 'templateName'>,
  submission: BronzeRawErasureSubmission,
): { path: string; body: Record<string, unknown> } {
  const anonIds = sanitizeRawIds(submission.anonIds);
  const deviceIds = sanitizeRawIds(submission.deviceIds);
  const labels = {
    'brain.io/job': 'bronze-raw-erasure',
    // brand_id is a tenant UUID (not subject PII) — labeled for per-brand ops traceability.
    // The subject hash is deliberately NOT a label (parameters only).
    'brain.io/brand-id': submission.brandId,
  };

  if (opts.mode === 'k8s') {
    return {
      path: `/apis/argoproj.io/v1alpha1/namespaces/${opts.namespace}/workflows`,
      body: {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Workflow',
        metadata: {
          generateName: `${opts.templateName}-`,
          namespace: opts.namespace,
          labels,
        },
        spec: {
          workflowTemplateRef: { name: opts.templateName },
          arguments: {
            parameters: [
              { name: 'brand-id', value: submission.brandId },
              { name: 'identifier-hash', value: submission.identifierHash },
              { name: 'anon-ids', value: anonIds.join(',') },
              { name: 'device-ids', value: deviceIds.join(',') },
            ],
          },
        },
      },
    };
  }

  return {
    path: `/api/v1/workflows/${opts.namespace}/submit`,
    body: {
      namespace: opts.namespace,
      resourceKind: 'WorkflowTemplate',
      resourceName: opts.templateName,
      submitOptions: {
        generateName: `${opts.templateName}-`,
        labels: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(','),
        parameters: [
          `brand-id=${submission.brandId}`,
          `identifier-hash=${submission.identifierHash}`,
          `anon-ids=${anonIds.join(',')}`,
          `device-ids=${deviceIds.join(',')}`,
        ],
      },
    },
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ArgoErasureWorkflowSubmitter implements IBronzeRawErasureSubmitter {
  constructor(private readonly opts: ArgoErasureWorkflowSubmitterOptions) {}

  async submit(submission: BronzeRawErasureSubmission): Promise<{ workflowName: string }> {
    const { path, body } = buildSubmitRequest(this.opts, submission);

    let base: URL;
    try {
      base = new URL(this.opts.serverUrl);
    } catch {
      throw new BronzeRawErasureSubmitError(`invalid server URL: ${this.opts.serverUrl}`);
    }

    const token = this.resolveToken();
    const ca = this.resolveCa();

    const status = await this.post(base, path, body, token, ca);
    const parsed = status.json as { metadata?: { name?: string } } | undefined;
    const workflowName = parsed?.metadata?.name;
    if (!workflowName) {
      throw new BronzeRawErasureSubmitError(
        `submit accepted (HTTP ${status.statusCode}) but response carried no workflow name`,
      );
    }
    return { workflowName };
  }

  /** Bearer token: static (argo-server / tests) or the projected SA token, read fresh per submit. */
  private resolveToken(): string | undefined {
    if (this.opts.authToken) return this.opts.authToken;
    if (this.opts.mode !== 'k8s') return undefined;
    const tokenFile = this.opts.tokenFile ?? `${K8S_SA_DIR}/token`;
    try {
      return readFileSync(tokenFile, 'utf8').trim();
    } catch (err) {
      // No token = the k8s API will 401 — fail NOW with the real reason (fail-safe, retryable).
      throw new BronzeRawErasureSubmitError(
        `cannot read ServiceAccount token at ${tokenFile}`, err,
      );
    }
  }

  /** Cluster CA bundle (k8s mode). Absent file → undefined (system CAs — dev/port-forward). */
  private resolveCa(): Buffer | undefined {
    const caFile = this.opts.caFile ?? (this.opts.mode === 'k8s' ? `${K8S_SA_DIR}/ca.crt` : undefined);
    if (!caFile) return undefined;
    try {
      return readFileSync(caFile);
    } catch {
      return undefined;
    }
  }

  private post(
    base: URL,
    path: string,
    body: Record<string, unknown>,
    token: string | undefined,
    ca: Buffer | undefined,
  ): Promise<{ statusCode: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const isHttps = base.protocol === 'https:';
      const doRequest = isHttps ? httpsRequest : httpRequest;

      const req = doRequest(
        {
          host: base.hostname,
          port: base.port || (isHttps ? 443 : 80),
          path,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(isHttps && ca ? { ca } : {}),
          timeout: this.opts.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              // Body may carry the k8s/Argo Status reason — bounded, no PII (params echo the
              // hash/ids we sent, which are already non-raw by contract).
              reject(new BronzeRawErasureSubmitError(
                `HTTP ${statusCode} from ${base.origin}${path}: ${text.slice(0, 512)}`,
              ));
              return;
            }
            try {
              resolve({ statusCode, json: JSON.parse(text) });
            } catch {
              resolve({ statusCode, json: undefined });
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`timed out after ${this.opts.timeoutMs}ms`));
      });
      req.on('error', (err) => {
        reject(err instanceof BronzeRawErasureSubmitError
          ? err
          : new BronzeRawErasureSubmitError(`${base.origin}${path}: ${String(err)}`, err));
      });

      req.write(payload);
      req.end();
    });
  }
}
