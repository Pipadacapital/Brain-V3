#!/usr/bin/env tsx
/**
 * contracts codegen — Zod → {OpenAPI 3.1, Avro .avsc, MCP tool JSON schema}
 *
 * Usage:  pnpm --filter @brain/contracts run gen:contracts
 *
 * Outputs:
 *   generated/openapi/openapi.json     — OpenAPI 3.1 specification
 *   generated/avro/collector.event.v1.avsc — Apache Avro schema
 *   generated/mcp/tools.json           — MCP tool JSON schema array
 *
 * INVARIANT: This script must be run and its output committed before any
 * API or event schema change ships (I-E01 contract-first).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import {
  CollectorEventV1Schema,
  COLLECTOR_EVENT_V1_AVRO_SUBJECT,
  IngestEventBodySchema,
  IngestEventAcceptedResponseSchema,
  ApiErrorResponseSchema,
  MCP_LOOKUP_SCHEMAS,
} from '../src/index.js';
// The SINGLE MCP tool-registry SoR (names, access, status, scope, schema refs). The codegen
// enumerates THIS — there is no second, divergent tool list here (the old brand_id-as-arg
// genMCP definition is removed; brand_id is never an MCP tool input — I-S01).
import { MCP_TOOLS } from '@brain/ai-gateway-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GENERATED_DIR = join(__dirname, '..', 'generated');

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensure(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function write(path: string, content: string) {
  writeFileSync(path, content, 'utf-8');
  console.log(`  wrote: ${path.replace(process.cwd(), '.')}`);
}

// ── 1. OpenAPI 3.1 ──────────────────────────────────────────────────────────

/**
 * Minimal Zod-to-JSON-Schema converter sufficient for Sprint-0 types.
 * For M1+ use zod-to-json-schema (already a viable dep; avoided here for zero-dep codegen).
 */
function zodToJsonSchema(schema: z.ZodTypeAny, defs: Record<string, unknown> = {}): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value, defs);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) result['required'] = required;
    return result;
  }

  if (schema instanceof z.ZodString) {
    const checks = (schema._def as { checks?: Array<{ kind: string; value?: unknown }> }).checks ?? [];
    const r: Record<string, unknown> = { type: 'string' };
    for (const c of checks) {
      if (c.kind === 'uuid') r['format'] = 'uuid';
      if (c.kind === 'datetime') r['format'] = 'date-time';
      if (c.kind === 'min') r['minLength'] = c.value;
      if (c.kind === 'max') r['maxLength'] = c.value;
    }
    return r;
  }

  if (schema instanceof z.ZodNumber) {
    const checks = (schema._def as { checks?: Array<{ kind: string }> }).checks ?? [];
    const r: Record<string, unknown> = { type: 'number' };
    if (checks.some((c) => c.kind === 'int')) r['type'] = 'integer';
    return r;
  }

  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };

  if (schema instanceof z.ZodLiteral) {
    return { const: (schema as z.ZodLiteral<unknown>).value };
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(schema.options as readonly string[])] };
  }

  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap(), defs);
  }

  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap(), defs) as Record<string, unknown>;
    return { oneOf: [inner, { type: 'null' }] };
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema._def.innerType as z.ZodTypeAny, defs);
    return { ...(inner as Record<string, unknown>), default: schema._def.defaultValue() };
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: zodToJsonSchema(schema.valueType, defs),
    };
  }

  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element, defs) };
  }

  if (schema instanceof z.ZodUnion) {
    return { oneOf: (schema.options as z.ZodTypeAny[]).map((o) => zodToJsonSchema(o, defs)) };
  }

  return {};
}

function genOpenAPI() {
  ensure(join(GENERATED_DIR, 'openapi'));

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Brain Collector API',
      version: '1.0.0',
      description: 'Auto-generated from @brain/contracts Zod schemas (I-E01).',
    },
    paths: {
      '/v1/events': {
        post: {
          operationId: 'ingestEvent',
          summary: 'Ingest a collector event',
          description:
            'Accept-before-validate: the event is spooled and acknowledged before schema validation or Kafka produce.',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', format: 'uuid' },
              description: 'Client-supplied idempotency UUID (I-ST04).',
            },
            {
              name: 'traceparent',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'W3C traceparent header for distributed tracing.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodToJsonSchema(IngestEventBodySchema),
              },
            },
          },
          responses: {
            '202': {
              description: 'Event accepted and spooled.',
              content: {
                'application/json': {
                  schema: zodToJsonSchema(IngestEventAcceptedResponseSchema),
                },
              },
            },
            '400': {
              description: 'Validation error.',
              content: {
                'application/json': { schema: zodToJsonSchema(ApiErrorResponseSchema) },
              },
            },
            '429': {
              description: 'Rate limited.',
              content: {
                'application/json': { schema: zodToJsonSchema(ApiErrorResponseSchema) },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CollectorEventV1: zodToJsonSchema(CollectorEventV1Schema),
        IngestEventBody: zodToJsonSchema(IngestEventBodySchema),
        IngestEventAcceptedResponse: zodToJsonSchema(IngestEventAcceptedResponseSchema),
        ApiErrorResponse: zodToJsonSchema(ApiErrorResponseSchema),
      },
    },
  };

  write(join(GENERATED_DIR, 'openapi', 'openapi.json'), JSON.stringify(spec, null, 2));
}

// ── 2. Avro .avsc (Apache Avro schema) ──────────────────────────────────────

/**
 * Hand-authored Avro schema derived from CollectorEventV1Schema.
 * In M1+, this will be generated from Zod via zod-to-avro or equivalent.
 * The subject name matches COLLECTOR_EVENT_V1_AVRO_SUBJECT for Apicurio registration.
 *
 * Schema evolution rules (FULL_TRANSITIVE / I-E02):
 *  - Add fields with defaults only.
 *  - Never remove, rename, or change the type of an existing field.
 */
function genAvro() {
  ensure(join(GENERATED_DIR, 'avro'));

  const avroSchema = {
    type: 'record',
    name: 'CollectorEventV1',
    namespace: 'brain.collector',
    doc: 'Canonical collector event envelope. Registered in Apicurio as brain.collector.event.v1.',
    fields: [
      {
        name: 'schema_version',
        type: 'string',
        default: '1',
        doc: 'Schema version — bump on additive changes only.',
      },
      {
        name: 'event_id',
        type: 'string',
        doc: 'UUIDv4 — combined with brand_id for idempotency (I-ST04).',
      },
      {
        name: 'brand_id',
        type: 'string',
        doc: 'Tenant key — required on every event (I-S01).',
      },
      {
        name: 'correlation_id',
        type: 'string',
        doc: 'Distributed trace correlation identifier (ADR-009).',
      },
      {
        name: 'event_name',
        type: 'string',
        doc: 'Dot-separated event name e.g. "page.viewed".',
      },
      {
        name: 'occurred_at',
        type: 'string',
        doc: 'ISO-8601 UTC timestamp of event occurrence.',
      },
      {
        name: 'ingested_at',
        type: ['null', 'string'],
        default: null,
        doc: 'ISO-8601 UTC timestamp set by the collector on receipt. stream-worker writes as timestamptz at Bronze boundary.',
      },
      {
        name: 'hashed_user_id',
        type: ['null', 'string'],
        default: null,
        doc: 'sha256(per-brand-salt || normalized_id). No raw PII (I-S02).',
      },
      {
        name: 'hashed_session_id',
        type: ['null', 'string'],
        default: null,
        doc: 'sha256(per-brand-salt || session_id). No raw PII (I-S02).',
      },
      {
        name: 'properties',
        type: { type: 'map', values: 'string' },
        default: {},
        doc: 'Arbitrary event properties serialised as string values. No raw PII.',
      },
    ],
  };

  write(
    join(GENERATED_DIR, 'avro', `${COLLECTOR_EVENT_V1_AVRO_SUBJECT.replace(/\./g, '.')}.avsc`),
    JSON.stringify(avroSchema, null, 2),
  );
}

// ── 3. MCP tool JSON schema ───────────────────────────────────────────────────

/**
 * Resolve a McpToolSpec schema ref (input/output) to its Zod schema → JSON schema. A ref that is
 * missing from MCP_LOOKUP_SCHEMAS is a build-time error (no silent drift between the registry SoR
 * and the contracts schemas).
 */
function refToJsonSchema(ref: string | undefined): unknown | undefined {
  if (ref === undefined) return undefined;
  const schema = MCP_LOOKUP_SCHEMAS[ref];
  if (schema === undefined) {
    throw new Error(`MCP codegen: tool references schema "${ref}" not found in MCP_LOOKUP_SCHEMAS`);
  }
  return zodToJsonSchema(schema);
}

/** Recursively collect every `properties` key name in a generated JSON schema (for the brand_id ban). */
function collectPropertyNames(node: unknown, acc: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.properties && typeof obj.properties === 'object') {
    for (const key of Object.keys(obj.properties as Record<string, unknown>)) acc.add(key);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach((v) => collectPropertyNames(v, acc));
    else collectPropertyNames(value, acc);
  }
}

/**
 * genMCP — enumerate the SINGLE tool-registry SoR (@brain/ai-gateway-client MCP_TOOLS). Every tool is
 * read-only (I-S08); a `disabled-not-implemented` tool is emitted with `disabled:true` + its reason and
 * NO input/output schema (it fails closed). brand_id is asserted ABSENT from every generated input
 * schema — the lookup key is brain_id; brand_id comes from the MCP principal (fixes the I-S01 divergence).
 */
function genMCP() {
  ensure(join(GENERATED_DIR, 'mcp'));

  const tools = MCP_TOOLS.map((t) => {
    const disabled = t.status === 'disabled-not-implemented';
    const inputSchema = refToJsonSchema(t.inputSchemaRef);
    const outputSchema = refToJsonSchema(t.outputSchemaRef);

    // I-S01: brand_id is NEVER a tool input — it is taken from the MCP principal.
    if (inputSchema !== undefined) {
      const props = new Set<string>();
      collectPropertyNames(inputSchema, props);
      if (props.has('brand_id')) {
        throw new Error(
          `MCP codegen: tool "${t.name}" input schema contains brand_id — brand_id must come from the principal, never a tool arg (I-S01).`,
        );
      }
    }

    return {
      name: t.name,
      description: t.description,
      read_only: true, // every tool is access:'read' (I-S08) — there is no write tool.
      access: t.access,
      status: t.status,
      ...(t.scope ? { scope: t.scope } : {}),
      ...(disabled ? { disabled: true, not_implemented_reason: t.notImplementedReason ?? null } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    };
  });

  write(join(GENERATED_DIR, 'mcp', 'tools.json'), JSON.stringify({ tools }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('contracts codegen — generating artifacts...');
genOpenAPI();
genAvro();
genMCP();
console.log('contracts codegen — done.');
