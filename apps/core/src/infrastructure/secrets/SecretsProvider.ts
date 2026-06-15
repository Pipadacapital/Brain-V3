/**
 * SecretsProvider — interface for fetching application-level secrets at startup.
 *
 * I-S09: secrets are never stored in environment variable values in production.
 * The env var holds the ARN/name; the value is fetched from the secrets backend.
 *
 * Implementations:
 *   - AwsSecretsProvider  → production (AWS Secrets Manager via IRSA)
 *   - LocalSecretsProvider → development/test (reads value directly from env)
 */
export interface SecretsProvider {
  /**
   * Resolve a secret by ARN or name.
   *
   * In production (AwsSecretsProvider): `nameOrArn` is an ARN or secret name;
   * the value is fetched from AWS Secrets Manager and returned.
   *
   * In development (LocalSecretsProvider): `nameOrArn` is treated as the raw
   * secret value (the env var already holds the plain text value in dev).
   *
   * @param nameOrArn  AWS Secrets Manager ARN/name (prod) or raw value (dev).
   * @returns          The resolved secret string value.
   * @throws           If the secret cannot be resolved — startup must fail-closed.
   */
  getSecret(nameOrArn: string): Promise<string>;
}
