/**
 * KIP-392 rack id for Kafka follower-fetching.
 *
 * Returns this pod's AWS availability zone so a kafkajs consumer created with `{ rackId }` fetches
 * from a SAME-AZ replica (the brokers run RackAwareReplicaSelector) instead of the cross-AZ leader —
 * cutting the DataTransfer-Regional-Bytes spend that dominates EC2-Other on the prod bill.
 *
 * Resolution order:
 *   1. `KAFKA_RACK_ID` env — explicit override (and how tests/dev pin a value).
 *   2. EC2 IMDSv2 `placement/availability-zone` — works in-cluster because the node metadata
 *      hop limit is 2 (see infra/terraform/modules/eks: http_put_response_hop_limit = 2).
 *
 * Best-effort by design: any failure, timeout, or blocked IMDS returns '' → the caller omits rackId
 * → kafkajs keeps today's leader-fetch behaviour. NEVER throws (must not break worker startup).
 */
const IMDS_BASE = 'http://169.254.169.254';

export async function resolveRackId(timeoutMs = 2000): Promise<string> {
  const override = process.env.KAFKA_RACK_ID?.trim();
  if (override) return override;

  const token = await imds('PUT', '/latest/api/token', timeoutMs, {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token) return '';

  const az = await imds('GET', '/latest/meta-data/placement/availability-zone', timeoutMs, {
    'X-aws-ec2-metadata-token': token,
  });
  return az.trim();
}

async function imds(
  method: 'GET' | 'PUT',
  path: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${IMDS_BASE}${path}`, { method, headers, signal: controller.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return ''; // unreachable/blocked/timeout → graceful no-rack
  } finally {
    clearTimeout(timer);
  }
}
