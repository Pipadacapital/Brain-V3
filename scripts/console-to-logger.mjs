/**
 * One-off codemod: replace console.{log,info,warn,error,debug} with the shared structured `log`.
 *  - console.log/info → log.info, debug → log.debug, warn → log.warn, error → log.error
 *  - strips a leading "[prefix] " from the first string/template-literal arg
 *  - extra args become a fields object: an err-ish identifier → { err: x }, else { detail: x }
 *  - adds `import { log } from '<rel>/log.js'` to any file that was transformed
 * Excludes *.test.ts, main.ts, and log.ts. Verify with tsc + the test suites afterwards.
 */
import { Project, SyntaxKind } from 'ts-morph';
import path from 'node:path';

const APPS = ['core', 'collector', 'stream-worker'];
const ROOT = path.resolve(process.cwd());
const LEVEL_MAP = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };

let totalCalls = 0;
let totalFiles = 0;

for (const app of APPS) {
  const project = new Project({ tsConfigFilePath: `${ROOT}/apps/${app}/tsconfig.json`, skipAddingFilesFromTsConfig: false });
  const srcDir = `${ROOT}/apps/${app}/src`;
  const logModule = `${srcDir}/log.ts`;

  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!fp.startsWith(srcDir)) continue;
    if (/\.test\.ts$|\/main\.ts$|\/log\.ts$/.test(fp)) continue;

    let changed = 0;
    // Collect console.* calls first (mutating during iteration is unsafe).
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => {
      const ex = c.getExpression();
      if (ex.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
      const pae = ex.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      return pae.getExpression().getText() === 'console' && pae.getName() in LEVEL_MAP;
    });

    for (const call of calls) {
      const pae = call.getExpression().asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const level = LEVEL_MAP[pae.getName()];
      const args = call.getArguments();
      if (args.length === 0) continue;

      // message arg — strip a leading "[...] " from a string/template literal.
      const msg = args[0];
      let msgText = msg.getText();
      const k = msg.getKind();
      if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral || k === SyntaxKind.TemplateExpression) {
        msgText = msgText.replace(/^([`'"])\[[^\]]*\]\s*/, '$1');
      }

      // extra args → fields object
      const rest = args.slice(1);
      let fieldsText = '';
      if (rest.length === 1) {
        const t = rest[0].getText();
        const key = /err/i.test(t.split('.').pop() ?? t) ? 'err' : 'detail';
        fieldsText = `{ ${key}: ${t} }`;
      } else if (rest.length > 1) {
        fieldsText = `{ ${rest.map((r, i) => `detail${i === 0 ? '' : i + 1}: ${r.getText()}`).join(', ')} }`;
      }

      const replacement = fieldsText ? `log.${level}(${msgText}, ${fieldsText})` : `log.${level}(${msgText})`;
      call.replaceWithText(replacement);
      changed += 1;
    }

    if (changed > 0) {
      // add the log import if absent
      const hasLog = sf.getImportDeclarations().some((d) => d.getNamedImports().some((n) => n.getName() === 'log'));
      if (!hasLog) {
        let rel = path.relative(path.dirname(fp), logModule).replace(/\.ts$/, '.js');
        if (!rel.startsWith('.')) rel = './' + rel;
        sf.addImportDeclaration({ moduleSpecifier: rel, namedImports: ['log'] });
      }
      sf.saveSync();
      totalFiles += 1;
      totalCalls += changed;
    }
  }
}

console.log(`codemod done: ${totalCalls} console.* calls across ${totalFiles} files`);
