/**
 * ConnectorFactory — resolves an IConnector implementation by provider id (Factory + Strategy).
 *
 * The factory is a registry: concrete connectors REGISTER themselves (or a thin adapter) keyed by
 * their provider id, and callers RESOLVE by id. This is the Open/Closed seam for the connector
 * platform — a new provider is added by registering a new IConnector, never by editing this class
 * or any caller. Provider ids are expected to match CONNECTOR_CATALOG entries (the catalog is the
 * marketplace SoR; the factory is the runtime resolution SoR).
 *
 * Registration is intentionally lazy/incremental: not every source must implement the full
 * IConnector today. A source registers once it adopts the unified contract; until then it keeps
 * its existing command/query wiring. The factory proves the pattern and gives new providers a
 * single place to plug in.
 */
import type { IConnector } from './IConnector.js';

/** A factory function that lazily constructs a connector (so deps are wired at resolve time). */
export type ConnectorRegistration = () => IConnector;

export class ConnectorNotRegisteredError extends Error {
  constructor(provider: string) {
    super(`[ConnectorFactory] No connector registered for provider "${provider}"`);
    this.name = 'ConnectorNotRegisteredError';
  }
}

export class ConnectorFactory {
  private readonly registry = new Map<string, ConnectorRegistration>();

  /**
   * Register a connector for a provider id. Idempotent-overwrite is NOT allowed — re-registering
   * the same provider throws, to catch double-wiring at startup.
   */
  register(provider: string, registration: ConnectorRegistration): this {
    if (this.registry.has(provider)) {
      throw new Error(`[ConnectorFactory] provider "${provider}" already registered`);
    }
    this.registry.set(provider, registration);
    return this;
  }

  /** True if a connector is registered for the provider id. */
  has(provider: string): boolean {
    return this.registry.has(provider);
  }

  /** Resolve the IConnector for a provider id, or throw if none is registered. */
  resolve(provider: string): IConnector {
    const registration = this.registry.get(provider);
    if (!registration) {
      throw new ConnectorNotRegisteredError(provider);
    }
    return registration();
  }

  /** Resolve, or return null if the provider has no registered connector. */
  tryResolve(provider: string): IConnector | null {
    const registration = this.registry.get(provider);
    return registration ? registration() : null;
  }

  /** All registered provider ids (for diagnostics / startup assertions). */
  registeredProviders(): readonly string[] {
    return [...this.registry.keys()];
  }
}
