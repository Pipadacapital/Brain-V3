/**
 * AwsSecretsProvider — production implementation of SecretsProvider.
 *
 * Fetches secrets from AWS Secrets Manager using IRSA credentials (no static
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). The SDK reads credentials from
 * the IRSA token file (AWS_WEB_IDENTITY_TOKEN_FILE) automatically.
 *
 * I-S09: the secret value is never logged, never written to env vars, never
 * stored in Postgres. It is held in memory only for the duration of startup
 * and then stored in the in-process config object.
 *
 * Usage:
 *   const provider = new AwsSecretsProvider(region);
 *   const jwtSecret = await provider.getSecret(process.env.JWT_SIGNING_SECRET_ARN!);
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import type { SecretsProvider } from './SecretsProvider.js';

export class AwsSecretsProvider implements SecretsProvider {
  private readonly client: SecretsManagerClient;

  constructor(region: string = process.env['AWS_REGION'] ?? 'us-east-1') {
    // SDK picks up IRSA credentials automatically via the web-identity token file.
    this.client = new SecretsManagerClient({ region });
  }

  async getSecret(nameOrArn: string): Promise<string> {
    let response: GetSecretValueCommandOutput;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: nameOrArn }),
      );
    } catch (err) {
      // Fail-closed: if we cannot resolve the secret, abort startup.
      throw new Error(
        `[AwsSecretsProvider] Failed to fetch secret "${nameOrArn}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const value = response.SecretString;
    if (!value) {
      throw new Error(
        `[AwsSecretsProvider] Secret "${nameOrArn}" resolved to an empty value`,
      );
    }

    return value;
  }
}
