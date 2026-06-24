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
 * documented envelope shape (infra/redpanda/schemas/collector.event.v1.avsc).
 *
 * @see infra/redpanda/schemas/collector.event.v1.avsc — canonical Avro schema
 * @see infra/redpanda/README.md — FULL_TRANSITIVE policy
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
 * Register an Avro schema in Apicurio with FULL_TRANSITIVE compatibility.
 * Called by the collector on startup to ensure the schema is registered.
 *
 * Throws if the schema is not compatible (non-additive change rejected by registry).
 */
export async function registerSchema(
  config: ApicurioConfig,
  avscJson: string
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
      'Content-Type': 'application/json; artifactType=AVRO',
      'X-Registry-ArtifactId': config.artifactId,
      'X-Registry-ArtifactType': 'AVRO',
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
 * Validate a schema change against Apicurio's compatibility rules (FULL_TRANSITIVE).
 * Used in CI to reject non-additive changes before they reach the registry.
 *
 * Returns { compatible: true } or throws with the incompatibility reason.
 */
export async function validateSchemaCompatibility(
  config: ApicurioConfig,
  avscJson: string
): Promise<{ compatible: boolean; reason?: string }> {
  const url =
    `${config.baseUrl}/apis/registry/v2/groups/${config.groupId}/artifacts/${config.artifactId}/versions/latest/compatibility`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; artifactType=AVRO' },
    body: avscJson,
  });

  if (response.status === 200) {
    return { compatible: true };
  }

  if (response.status === 409) {
    const body = await response.json() as { message?: string };
    return {
      compatible: false,
      reason: body.message ?? 'Schema incompatible with FULL_TRANSITIVE policy',
    };
  }

  // Artifact not found — this is the first version, always compatible
  if (response.status === 404) {
    return { compatible: true };
  }

  const error = await response.text();
  throw new Error(`[events] Compatibility check failed (${response.status}): ${error}`);
}

/**
 * Build the Redpanda partition key from envelope fields.
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
