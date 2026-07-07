// SPEC: F.5
/**
 * @brain/prompt-loader — loader skeleton for the git-backed `prompts/` directory.
 *
 * §F: "Git-backed `prompts/` + loader; no runtime."
 *
 * SCAFFOLD-ONLY (PLAN-OF-RECORD §PART 6): a PORT (the loader interface + the versioned-template
 * record shape) plus a failing-by-design adapter. Templates are versioned files under the repo-root
 * `prompts/` directory (git IS the version store — no DB, no registry service). There is NO agent
 * runtime here and NO template-render/interpolation engine — resolving a template's VALUE (fs read
 * + render) is DEFERRED to the wave that ships prompt execution.
 *
 * The manifest (`prompts/manifest.json`) is the authored index of every template + its versions.
 */

/** A single versioned prompt template's manifest entry — mirrors an entry in prompts/manifest.json. */
export interface PromptTemplateRef {
  /** Logical template id (stable across versions), e.g. "copilot.system". */
  readonly id: string;
  /** Semantic version of THIS template revision, e.g. "1". */
  readonly version: string;
  /** Repo-relative path to the template file (git-backed), e.g. "prompts/copilot/system.v1.md". */
  readonly path: string;
  /** Task-class alias this template targets (litellm task_class_routing), if any. */
  readonly taskClass?: string;
  /** One-line description of the template's purpose. */
  readonly description?: string;
}

/** The shape of prompts/manifest.json — the authored index of all git-backed templates. */
export interface PromptManifest {
  readonly version: string;
  readonly templates: readonly PromptTemplateRef[];
}

/**
 * PromptLoaderPort — resolves a template id+version to its raw text. A real adapter (later wave)
 * reads the git-backed file and returns its contents; no interpolation happens in this package.
 */
export interface PromptLoaderPort {
  /** List every template ref from the manifest. */
  list(): Promise<readonly PromptTemplateRef[]>;
  /**
   * load — return the raw template text for an id (optionally pinned to a version; else latest).
   * @throws PromptLoaderNotImplementedError in the scaffold (no fs runtime is wired).
   */
  load(id: string, version?: string): Promise<string>;
}

/** Thrown by the scaffold loader — template TEXT resolution is deferred (no runtime). */
export class PromptLoaderNotImplementedError extends Error {
  readonly code = 'PROMPT_LOADER_NOT_IMPLEMENTED';
  constructor() {
    super(
      'prompt-loader is a scaffold skeleton (SPEC:F.5): git-backed templates + manifest exist, but ' +
        'no fs/runtime resolution is wired. Load a template once the consuming wave ships.',
    );
    this.name = 'PromptLoaderNotImplementedError';
  }
}

/**
 * NotImplementedPromptLoader — the failing-by-design adapter. Accepts a parsed manifest so `list`
 * is honest (the authored index IS available at scaffold time), but `load` (text resolution) throws.
 */
export class NotImplementedPromptLoader implements PromptLoaderPort {
  constructor(private readonly manifest: PromptManifest) {}

  async list(): Promise<readonly PromptTemplateRef[]> {
    return this.manifest.templates;
  }

  async load(_id: string, _version?: string): Promise<string> {
    throw new PromptLoaderNotImplementedError();
  }
}
