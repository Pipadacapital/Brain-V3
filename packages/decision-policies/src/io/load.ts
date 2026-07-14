// SPEC: H
/**
 * @brain/decision-policies — YAML LOAD SEAM (DEFERRED).
 *
 * Turning a `policies/<name>.v<n>.yaml` FILE into a parsed document (fs read + YAML parse) is a thin
 * adapter deliberately deferred: the compiler skeleton (../compiler) operates on an ALREADY-PARSED
 * document (`unknown`), so shape validation is testable with zero external deps. When the package is
 * activated, wire a YAML parser here (e.g. the `yaml` package) and feed the result to compilePolicy.
 *
 * Kept as a failing-by-design seam so the scaffold introduces NO unpinned runtime dependency now.
 */

/**
 * DEFERRED: read + YAML-parse a policy file into a plain document for compilePolicy(). Throws today.
 * @throws Error always — parse wiring is deferred until Wave H activation.
 */
export function loadPolicyDocument(_yamlText: string): unknown {
  throw new Error(
    'decision-policies YAML parse is not wired (Wave H scaffold — DEFERRED). ' +
      'Pass an already-parsed document to compilePolicy() for now.',
  );
}
