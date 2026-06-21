# RB-4 — Local lakehouse (Iceberg REST catalog + MinIO)

The local stand-in for the production Bronze substrate (AWS Glue + S3). Used to develop and
verify the Iceberg Bronze flip (ADR-0002) without AWS. **Optional infra** — not part of the
default `pnpm dev` loop, because the live ingest path still writes Bronze to Postgres until the
flip completes.

## Components

| Service | Image | Port | Role |
|---|---|---|---|
| `iceberg-rest` | `apache/iceberg-rest-fixture:1.9.2` | `8181` | Iceberg REST catalog (local equivalent of AWS Glue Data Catalog) |
| `minio` | `minio/minio` | `9000` / `9001` | S3-compatible object store; warehouse = `s3://brain-bronze/` |

Catalog → object-store wiring (compose env on `iceberg-rest`): `CATALOG_WAREHOUSE=s3://brain-bronze/`,
`CATALOG_S3_ENDPOINT=http://minio:9000`, path-style access, creds `brain` / `brainbrain`.

> Replaces the previously-broken `projectnessie/nessie:0.90.2` (unpullable tag, PR #72).

## Start

```bash
pnpm dev:lakehouse        # docker compose --profile lakehouse up -d  (brings up minio + iceberg-rest)
```

## Verify

```bash
# catalog config (proves the REST catalog is up)
curl -s http://localhost:8181/v1/config | jq .

# container health
docker compose ps | grep -E 'iceberg-rest|minio'      # both should be (healthy)

# MinIO console: http://localhost:9001  (brain / brainbrain) — warehouse bucket: brain-bronze
```

Expected: `GET /v1/config` → HTTP 200 with the endpoint list; `iceberg-rest` and `minio` both
`(healthy)`.

## StarRocks → Iceberg catalog (read path; wired in a later slice)

`db/starrocks/external_iceberg_catalog.sql` and `db/starrocks/bootstrap.sql` define the
`brain_bronze_local` external catalog pointing at `http://iceberg-rest:8181`. This is exercised
when the analytics reader flip lands (ADR-0002, Slice 4) — not in the default dev loop.

## Stop / reset

```bash
docker compose --profile lakehouse down          # stop (keep volumes)
docker compose --profile lakehouse down -v       # wipe the local warehouse + catalog state
```

## Troubleshooting

- **`iceberg-rest` unhealthy / `:8181` refused:** check `minio` is healthy first (the catalog
  `depends_on` it); `docker compose logs iceberg-rest`.
- **Image pull fails:** confirm the pinned tag `apache/iceberg-rest-fixture:1.9.2` is reachable;
  do not fall back to `:latest` in committed compose (reproducibility).
- **`brand-bronze` bucket missing:** `minio-init` creates `brain-bronze` + `brain-audit` on first
  boot; re-run `docker compose --profile lakehouse up -d` if it was skipped.

## Related

- ADR-0002 — `docs/adr/0002-iceberg-bronze-spark-streaming.md` (the Bronze→Iceberg flip plan)
- RB-3 — StarRocks rebuild-from-Iceberg
