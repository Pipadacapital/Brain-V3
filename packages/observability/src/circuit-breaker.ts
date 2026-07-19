/**
 * circuit-breaker.ts — Closed/Open/HalfOpen circuit breaker (GoF/resilience pattern).
 *
 * Wraps any async call (a vendor API call, a gRPC downstream, etc.) so a slow or failing
 * dependency degrades gracefully instead of cascading through the ingest-scheduler tick.
 *
 * State machine:
 *   CLOSED   → normal operation; failures counted by a sliding window.
 *   OPEN     → fail-fast (throws CircuitOpenError immediately; no call issued) after the
 *               failure threshold is crossed. Stays OPEN for `openMs` (the "cool-down
 *               deadline"), then transitions to HALF_OPEN.
 *   HALF_OPEN → a single probe call is allowed. On success → CLOSED (window reset). On
 *               failure → OPEN again (cool-down restarts).
 *
 * Usage:
 *   const breaker = new CircuitBreaker({ name: 'shopify', failureThreshold: 5, openMs: 30_000 });
 *   const result = await breaker.fire(() => client.fetchOrdersPage(...));
 *
 * Every state transition emits an OTel counter + a structured log line so the breaker
 * state is observable via Prometheus/Grafana without a separate dashboard add-on.
 *
 * The circuit breaker is intentionally LOCAL to each vendor-client instance. Shared state
 * across replicas (e.g. Redis-backed) is a follow-on — for the ingest-scheduler's
 * sequential per-connector tick, per-process isolation is correct and sufficient.
 *
 * PII: the `name` label is the vendor/service name (e.g. 'shopify', 'meta') — low-cardinality,
 * never a customer identifier. Safe as a metric label.
 */

import { incrementCounter } from './index.js';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is OPEN — failing fast`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Human-readable name used in metrics + logs (e.g. 'shopify', 'meta', 'razorpay'). */
  name: string;
  /**
   * Number of consecutive failures before transitioning CLOSED → OPEN.
   * Default: 5.
   */
  failureThreshold?: number;
  /**
   * Milliseconds the breaker stays OPEN before transitioning → HALF_OPEN (the deadline).
   * Default: 30 000 (30 s).
   */
  openMs?: number;
  /**
   * Optional per-call timeout in milliseconds. When set, `fire()` races the wrapped
   * call against a deadline; a timeout counts as a failure (same as a thrown error).
   * Default: undefined (no extra timeout — the caller is already expected to supply
   * AbortSignal.timeout on the underlying fetch).
   */
  callTimeoutMs?: number;
  /**
   * Optional predicate deciding whether a thrown error counts as a breaker FAILURE.
   * Return false for errors that mean "the dependency RESPONDED, this is an expected/handled
   * business signal" (e.g. a vendor 400 "reduce the amount of data", a rate-limit the caller
   * already backs off on, an auth error routed to reconnect) — those must NOT trip the circuit,
   * because the service is reachable. Such errors are treated as a SUCCESS for breaker state
   * (they close a HALF_OPEN probe) but are STILL re-thrown for the caller to handle.
   * Default: () => true (every error is a failure — the original behaviour).
   */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly callTimeoutMs: number | undefined;
  private readonly isFailure: (err: unknown) => boolean;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 30_000;
    this.callTimeoutMs = opts.callTimeoutMs;
    this.isFailure = opts.isFailure ?? (() => true);
  }

  /** Current state (for inspection / tests). */
  getState(): BreakerState {
    return this.state;
  }

  /** Current consecutive-failure count (for tests). */
  getFailures(): number {
    return this.failures;
  }

  /**
   * Execute the wrapped call through the circuit breaker.
   *
   * @throws CircuitOpenError when the breaker is OPEN (fail-fast, no call issued).
   * @throws the underlying error when the call fails in CLOSED or HALF_OPEN state.
   */
  async fire<T>(call: () => Promise<T>): Promise<T> {
    // Check for OPEN → HALF_OPEN transition based on elapsed time.
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.openMs) {
        this._transition('HALF_OPEN');
      } else {
        incrementCounter('circuit_breaker_rejected_total', { name: this.name });
        throw new CircuitOpenError(this.name);
      }
    }

    let result: T;
    try {
      result = await this._runWithTimeout(call);
    } catch (err) {
      // A caller-classified NON-failure (the dependency responded with an expected/handled signal)
      // must not trip the breaker: the service is reachable, so treat it as a success for breaker
      // state (closes a HALF_OPEN probe) — but still re-throw so the caller handles it.
      if (this.isFailure(err)) {
        this._onFailure(err);
      } else {
        this._onSuccess();
      }
      throw err;
    }

    this._onSuccess();
    return result;
  }

  /** Force the breaker to CLOSED (for test teardown or administrative override). */
  reset(): void {
    this.failures = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _runWithTimeout<T>(call: () => Promise<T>): Promise<T> {
    if (!this.callTimeoutMs) return call();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Circuit breaker '${this.name}' call timeout (${this.callTimeoutMs}ms)`));
      }, this.callTimeoutMs);
    });
    try {
      return await Promise.race([call(), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private _onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this._transition('CLOSED');
    }
    this.failures = 0;
  }

  private _onFailure(_err: unknown): void {
    this.failures += 1;
    incrementCounter('circuit_breaker_failure_total', { name: this.name, state: this.state });

    if (this.state === 'HALF_OPEN') {
      // Probe failed — re-open (cool-down restarts).
      this._transition('OPEN');
      return;
    }

    if (this.state === 'CLOSED' && this.failures >= this.failureThreshold) {
      this._transition('OPEN');
    }
  }

  private _transition(next: BreakerState): void {
    const prev = this.state;
    this.state = next;
    if (next === 'OPEN') {
      this.openedAt = Date.now();
    } else if (next === 'CLOSED') {
      this.failures = 0;
      this.openedAt = 0;
    }
    incrementCounter('circuit_breaker_state_change_total', {
      name: this.name,
      from: prev,
      to: next,
    });
  }
}
