#!/usr/bin/env bash
###############################################################################
# Seed brain/prod/k8s/core-env (deferred at first seeding). Reuses the existing
# brain_app + neo4j passwords from the already-seeded secrets (server-side; never
# printed) and wires the app-boot ARNs. SHOPIFY_CLIENT_SECRET is a resolvable
# placeholder (Shopify connector is reconnected post-launch).
###############################################################################
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
WB=brain-bronze-prod-380254378136
JWT_ARN='arn:aws:secretsmanager:ap-south-1:380254378136:secret:brain/prod/app/jwt-signing-secret-1UKYs5'
COOKIE_ARN='arn:aws:secretsmanager:ap-south-1:380254378136:secret:brain/prod/app/cookie-secret-wEIEq0'
SHOPIFY_PLACEHOLDER_ARN='arn:aws:secretsmanager:ap-south-1:380254378136:secret:brain/prod/app/meta-app-secret-TyIIBt'

# brain_app password (from collector-env DATABASE_URL) + neo4j password (neo4j-auth)
APP_URL=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id brain/prod/k8s/collector-env --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['DATABASE_URL'])")
export APP_PW=$(printf '%s' "$APP_URL" | sed -E 's|postgres://brain_app:([^@]+)@.*|\1|')
export NEO4J_PW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id brain/prod/k8s/neo4j-auth --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['NEO4J_AUTH'].split('/',1)[1])")
export AUR WB JWT_ARN COOKIE_ARN SHOPIFY_PLACEHOLDER_ARN

CORE=$(python3 <<'PY'
import json, os
app=os.environ['APP_PW']; neo=os.environ['NEO4J_PW']; aur=os.environ['AUR']; wb=os.environ['WB']
print(json.dumps({
 "DATABASE_URL": f"postgres://brain_app:{app}@pgbouncer.pgbouncer.svc.cluster.local:6432/brain",
 "BRAIN_APP_DATABASE_URL": f"postgres://brain_app:{app}@pgbouncer.pgbouncer.svc.cluster.local:6432/brain",
 "DATABASE_URL_DIRECT": f"postgres://brain_app:{app}@{aur}:5432/brain?sslmode=require",
 "REDIS_URL": "rediss://master.brain-prod-redis.5eykyx.aps1.cache.amazonaws.com:6379",
 "KAFKA_BROKERS": "brain-prod-kafka-kafka-bootstrap.kafka.svc.cluster.local:9092",
 "TRINO_HOST": "brain-prod-trino.trino.svc.cluster.local",
 "TRINO_PORT": "8080",
 "ICEBERG_REST_URI": "http://brain-prod-iceberg-rest.iceberg-rest.svc.cluster.local:8181",
 "ICEBERG_WAREHOUSE": f"s3://{wb}/",
 "CHECKPOINT_LOCATION": f"s3a://{wb}/_checkpoints",
 "AUDIT_CHECKPOINT_BUCKET": "brain-audit-prod-380254378136",
 "AWS_REGION": "ap-south-1",
 "NEO4J_URI": "bolt://neo4j.neo4j.svc.cluster.local:7687",
 "NEO4J_USER": "neo4j",
 "NEO4J_PASSWORD": neo,
 "CONNECTOR_SECRETS_KMS_KEY_ID": "alias/brain-connector-secrets-prod",
 "JWT_SIGNING_SECRET": os.environ['JWT_ARN'],
 "COOKIE_SECRET": os.environ['COOKIE_ARN'],
 "SHOPIFY_CLIENT_SECRET": os.environ['SHOPIFY_PLACEHOLDER_ARN'],
 # core FAILS CLOSED in prod if either of these is absent (main.ts), and resolves
 # both as ARNs via AwsSecretsProvider at boot — so they must point at a secret
 # WITH a value. Reuse the meta-app placeholder (seeded by seed-app-boot-secrets.sh);
 # the real client secrets are written when the Meta / Google Ads connectors are
 # reconnected in the UI post-launch.
 "META_APP_SECRET": os.environ['SHOPIFY_PLACEHOLDER_ARN'],
 "GOOGLE_ADS_CLIENT_SECRET": os.environ['SHOPIFY_PLACEHOLDER_ARN'],
 "APP_BASE_URL": "https://app.brain.pipadacapital.com",
 "BRAIN_WEBHOOK_BASE_URL": "https://api.brain.pipadacapital.com",
 "PIXEL_INGEST_BASE_URL": "https://px.brain.pipadacapital.com",
}))
PY
)
aws secretsmanager put-secret-value --region "$REGION" --secret-id brain/prod/k8s/core-env --secret-string "$CORE" >/dev/null
n=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id brain/prod/k8s/core-env --query 'length(SecretString)' --output text)
echo "seeded brain/prod/k8s/core-env (AWSCURRENT len=$n)"
