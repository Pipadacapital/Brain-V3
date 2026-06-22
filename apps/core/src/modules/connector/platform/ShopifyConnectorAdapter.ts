/**
 * ShopifyConnectorAdapter — the REFERENCE IConnector implementation that proves the unified
 * contract (@brain/connector-core) + ConnectorFactory pattern compiles and resolves end-to-end.
 *
 * This is a THIN adapter over the connector kernel + the Shopify host policy. It is deliberately
 * minimal: it demonstrates the eight-verb IConnector lifecycle keyed off CONNECTOR_CATALOG and
 * registered into the factory (Factory + Strategy). The existing Shopify command/query classes
 * (HandleOAuthCallbackCommand, DisconnectCommand, RegisterWebhooksCommand, ...) remain the real
 * DI-wired execution path; this adapter is the single seam a future migration threads them
 * through. Each verb documents which existing command it will delegate to once the full
 * platform migration lands — until then the verbs that need live DI throw a clear "not yet wired"
 * error, while the pure ones (provider id, host validation, entity construction) are real.
 *
 * Adding a new provider = a new adapter like this + one `factory.register(...)` line. Never a
 * per-source fork of the lifecycle (Single-Primitive Rule + Open/Closed).
 */
import {
  type IConnector,
  type AuthResult,
  type ValidationResult,
  type HealthResult,
  type ConnectorInstance,
  type ConnectorSyncStatus,
} from '@brain/connector-core';
import { isValidShopDomain } from '../sources/storefront/shopify/domain/ShopifyHostPolicy.js';

/** Auth params for Shopify OAuth (the callback query: code + shop + state). */
export interface ShopifyAuthParams {
  readonly shop: string;
  readonly code: string;
  readonly state: string;
}

const NOT_WIRED = (verb: string): never => {
  throw new Error(
    `[ShopifyConnectorAdapter] ${verb}() is not yet wired to its command in this reference ` +
      `adapter — the live path remains the DI-wired Shopify command classes. ` +
      `Thread it through during the full connector-platform migration.`,
  );
};

export class ShopifyConnectorAdapter implements IConnector<ShopifyAuthParams, ShopifyAuthParams, unknown, unknown> {
  readonly provider = 'shopify';

  /** Cheap, side-effect-free validation: the Shopify host rule (NN-4) lives in ShopifyHostPolicy. */
  async validate(_brandId: string, params: ShopifyAuthParams): Promise<ValidationResult> {
    if (!params.shop || !isValidShopDomain(params.shop)) {
      return { valid: false, reason: `shop "${params.shop}" is not a valid *.myshopify.com host` };
    }
    if (!params.code) return { valid: false, reason: 'missing OAuth code' };
    if (!params.state) return { valid: false, reason: 'missing OAuth state' };
    return { valid: true };
  }

  /** Delegates to HandleOAuthCallbackCommand (token exchange + secret store → ARN, NN-2). */
  async authenticate(_brandId: string, _params: ShopifyAuthParams): Promise<AuthResult> {
    return NOT_WIRED('authenticate');
  }

  /** Delegates to HandleOAuthCallbackCommand (creates the ConnectorInstance via the host policy). */
  async connect(_brandId: string, _params: ShopifyAuthParams): Promise<ConnectorInstance> {
    return NOT_WIRED('connect');
  }

  /** Delegates to RequestConnectorSyncCommand. */
  async sync(_brandId: string, _params: unknown): Promise<ConnectorSyncStatus> {
    return NOT_WIRED('sync');
  }

  /** Delegates to the Shopify backfill job. */
  async backfill(_brandId: string, _params: unknown): Promise<ConnectorSyncStatus> {
    return NOT_WIRED('backfill');
  }

  /** Delegates to the Shopify webhook handler (HMAC verify → map → emit). */
  async webhook(_brandId: string, _params: unknown): Promise<void> {
    return NOT_WIRED('webhook');
  }

  /** Delegates to the connector health probe (maps onto the entity health/safety). */
  async health(_brandId: string): Promise<HealthResult> {
    return NOT_WIRED('health');
  }

  /** Delegates to DisconnectCommand (flips the instance to disconnected/blocked). */
  async disconnect(_brandId: string): Promise<ConnectorInstance> {
    return NOT_WIRED('disconnect');
  }
}
