// SPEC: 0.5
/**
 * @brain/domain-journey — hexagonal DOMAIN package placeholder (Commerce-OS Wave A, WA-02).
 *
 * This package exists so the SPEC 0.5 hexagonal ESLint boundary zone (eslint.config.mjs,
 * `packages/domain-*` → `domain` element) is exercised from day one: domain packages hold
 * pure domain logic + PORT interfaces only, and must not import infrastructure clients
 * (kafkajs / ioredis / redis / neo4j-driver / pg / trino) or the in-repo adapter packages
 * (@brain/db, @brain/metric-engine). Adapters are injected at the composition root.
 *
 * Wave B (journey domain) lands its real domain model + ports here. Until then this module
 * exports only the zone marker below — deliberately no behavior.
 */

/**
 * Marker constant proving the package participates in the `domain` boundary zone.
 * The zone's enforcement test lives at src/spec-0-5-hexagonal-boundary.test.ts.
 */
export const DOMAIN_PACKAGE = 'domain-journey' as const;
