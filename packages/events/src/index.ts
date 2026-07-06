/**
 * @brain/events — Avro schema register/validate against Apicurio (FULL_TRANSITIVE)
 *
 * Phase 1 / Sprint-0: provides the Apicurio schema registration and validation
 * utilities used by the collector (register on startup) and stream-worker
 * (validate on consume). Wire format = Avro. Compatibility = FULL_TRANSITIVE.
 *
 * Dependency: Track A (packages/contracts) supplies the canonical Zod schema
 * which is codegen'd to an Avro .avsc file. This package consumes the .avsc.
 *
 * Until packages/contracts codegen is complete, this stubs against the
 * documented envelope shape (infra/kafka/schemas/collector.event.v1.avsc).
 *
 * @see infra/kafka/schemas/collector.event.v1.avsc — canonical Avro schema
 * @see infra/kafka/README.md — FULL_TRANSITIVE policy
 * @see STACK.md EventAdapter (ADR-003)
 */

// ---------------------------------------------------------------------------
// Envelope type (mirrors collector.event.v1.avsc)
// Full Zod + codegen types come from packages/contracts (Track A).
// ---------------------------------------------------------------------------
export interface CollectorEventEnvelope {
  event_id:         string;
  brand_id:         string;
  occurred_at:      string;   // ISO-8601 UTC string; stream-worker converts to timestamptz at Bronze boundary
  ingested_at:      string;   // ISO-8601 UTC string; stream-worker converts to timestamptz at Bronze boundary
  schema_name:      string;
  schema_version:   number;
  partition_key:    string;   // brand_id:event_id
  correlation_id:   string;
  event_type:       string;
  payload:          string;   // JSON-encoded; no raw PII (I-S02)
  collector_version?: string | null;
}

// ---------------------------------------------------------------------------
// Apicurio client wrapper — FULL_TRANSITIVE enforcement
// ---------------------------------------------------------------------------
export interface ApicurioConfig {
  baseUrl:     string;
  groupId:     string;
  artifactId:  string;
  version?:    number;
}

export interface SchemaRegistrationResult {
  artifactId:  string;
  version:     number;
  globalId:    number;
  compatible:  boolean;
  error?:      string;
}

/**
 * Artifact types this wrapper registers. AVRO = the collector envelope lane; JSON (JSON Schema) =
 * the AMD-03-sanctioned type for NEW identity/action program artifacts (pixel.identify.v1, the
 * AMD-08 map-mutation lane, action.*.v1) — registry-registered under the same FULL_TRANSITIVE rule.
 */
export type ApicurioArtifactType = 'AVRO' | 'JSON';

/**
 * Register a schema in Apicurio with FULL_TRANSITIVE compatibility.
 * Called by the collector on startup to ensure the schema is registered.
 *
 * `artifactType` defaults to AVRO (the original collector-envelope behavior, unchanged);
 * pass 'JSON' to register a JSON Schema artifact (AMD-03 new-artifact convention).
 *
 * Throws if the schema is not compatible (non-additive change rejected by registry).
 */
export async function registerSchema(
  config: ApicurioConfig,
  avscJson: string,
  artifactType: ApicurioArtifactType = 'AVRO'
): Promise<SchemaRegistrationResult> {
  // Apicurio Registry v2 takes `ifExists` as a QUERY PARAMETER, not the v1-style
  // `X-Registry-IfExists` header (which this endpoint silently ignores → POST defaults to
  // fail-if-exists → 409 on every re-registration). RETURN_OR_UPDATE makes re-registering an
  // identical schema idempotent (returns the existing artifact); a genuinely non-additive change
  // still 409s under the FULL_TRANSITIVE rule, which we surface as an error below.
  const url =
    `${config.baseUrl}/apis/registry/v2/groups/${config.groupId}/artifacts?ifExists=RETURN_OR_UPDATE`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `application/json; artifactType=${artifactType}`,
      'X-Registry-ArtifactId': config.artifactId,
      'X-Registry-ArtifactType': artifactType,
    },
    body: avscJson,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[events] Apicurio schema registration failed (${response.status}): ${error}. ` +
      `This likely indicates a non-additive schema change (FULL_TRANSITIVE policy).`
    );
  }

  const result = await response.json() as { id: string; version: number; globalId: number };
  return {
    artifactId:  result.id,
    version:     result.version,
    globalId:    result.globalId,
    compatible:  true,
  };
}

/**
 * Ensure the artifact carries the COMPATIBILITY rule (default FULL_TRANSITIVE) — idempotent.
 *
 * SPEC: 1.7 (AMD-03, BINDING): the compose-env compatibility setting provably does NOT
 * materialize a registry rule; rule creation must be an explicit idempotent boot step via
 * REST. Without a rule on the artifact (or a global rule), Apicurio's compatibility test
 * endpoint checks NOTHING and every breaking change passes silently.
 *
 * Live-verified against Apicurio 2.6.3 (:8080): POST rule → 204 created; POST when the rule
 * already exists → 409 (treated as success — the rule is present, which is the goal).
 */
export async function ensureCompatibilityRule(
  config: ApicurioConfig,
  rule: 'FULL_TRANSITIVE' | 'FULL' | 'BACKWARD_TRANSITIVE' | 'BACKWARD' = 'FULL_TRANSITIVE'
): Promise<void> {
  const url =
    `${config.baseUrl}/apis/registry/v2/groups/${config.groupId}/artifacts/${config.artifactId}/rules`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'COMPATIBILITY', config: rule }),
  });

  // 204 = rule created; 409 = rule already exists on the artifact (idempotent success).
  if (response.status === 204 || response.status === 409) return;

  const error = await response.text();
  throw new Error(`[events] Failed to ensure COMPATIBILITY rule (${response.status}): ${error}`);
}

/**
 * Validate a schema change against Apicurio's compatibility rules (FULL_TRANSITIVE).
 * Used in CI to reject non-additive changes before they reach the registry.
 *
 * SPEC: 1.7 (AMD-03 fix, WA-02): the previous implementation POSTed to
 * `/versions/latest/compatibility`, an endpoint that DOES NOT EXIST in Apicurio Registry
 * v2 (live-verified 404 on 2.6.3) — and then treated 404 as "compatible", so every check
 * silently passed, breaking changes included. The correct 2.6 API is the dry-run rule
 * test: `PUT /apis/registry/v2/groups/{g}/artifacts/{id}/test` (testUpdateArtifact) —
 * live-verified: 204 = rules pass, 409 = RuleViolationException (incompatible), 404 = the
 * ARTIFACT genuinely does not exist (first version → compatible).
 *
 * NOTE: the test endpoint only enforces rules that exist — pair with
 * ensureCompatibilityRule() (the AMD-03 idempotent boot step) or the check is decorative.
 *
 * Returns { compatible: true } / { compatible: false, reason } or throws on transport errors.
 */
export async function validateSchemaCompatibility(
  config: ApicurioConfig,
  avscJson: string
): Promise<{ compatible: boolean; reason?: string }> {
  const url =
    `${config.baseUrl}/apis/registry/v2/groups/${config.groupId}/artifacts/${config.artifactId}/test`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; artifactType=AVRO' },
    body: avscJson,
  });

  // 2xx (204 on 2.6.3) — all configured rules pass.
  if (response.ok) {
    return { compatible: true };
  }

  // 409 — RuleViolationException: the schema breaks the artifact's compatibility rule.
  if (response.status === 409) {
    const body = await response.json() as {
      message?: string;
      detail?: string;
      causes?: Array<{ context?: string; description?: string }>;
    };
    const causes = (body.causes ?? [])
      .map((c) => [c.description, c.context && `at ${c.context}`].filter(Boolean).join(' '))
      .filter(Boolean)
      .join('; ');
    return {
      compatible: false,
      reason: causes || body.detail || body.message || 'Schema incompatible with FULL_TRANSITIVE policy',
    };
  }

  // 404 — the ARTIFACT does not exist (this is the real artifact-missing signal on the
  // /test endpoint, unlike the old nonexistent-endpoint 404): first version, compatible.
  if (response.status === 404) {
    return { compatible: true };
  }

  const error = await response.text();
  throw new Error(`[events] Compatibility check failed (${response.status}): ${error}`);
}

/**
 * Build the Kafka partition key from envelope fields.
 * Partition key = brand_id + ":" + event_id (brand-prefixed composite).
 */
export function buildPartitionKey(brandId: string, eventId: string): string {
  return `${brandId}:${eventId}`;
}

/**
 * Build the default Apicurio config from environment variables.
 * Falls back to local dev defaults.
 */
export function defaultApicurioConfig(): ApicurioConfig {
  return {
    baseUrl:    process.env['APICURIO_URL'] ?? 'http://localhost:8080',
    groupId:    process.env['APICURIO_GROUP'] ?? 'brain',
    artifactId: process.env['APICURIO_ARTIFACT_ID'] ?? 'collector.event.v1',
  };
}
