/**
 * LocalSecretsProvider — development implementation of SecretsProvider.
 *
 * In local dev the env var already contains the secret VALUE (not an ARN).
 * This provider simply returns the value as-is.
 *
 * NEVER use this in production. The NODE_ENV guard in main.ts enforces this.
 */
import type { SecretsProvider } from './SecretsProvider.js';

export class LocalSecretsProvider implements SecretsProvider {
  async getSecret(value: string): Promise<string> {
    if (!value) {
      throw new Error('[LocalSecretsProvider] Empty secret value — check the env var');
    }
    return value;
  }
}
