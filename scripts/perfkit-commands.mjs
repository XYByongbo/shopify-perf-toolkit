// Required options are bare. Brackets mark options with a default or optional value.
const definitions = {
  'toolkit-manifest': '[--out <manifest.json>]',
  'theme-capabilities': ['--project <theme> [--config <identity-context.json>] [--out <capabilities.json>]', 'theme-capabilities', 'validateThemeCapabilitiesConfig'],
  'resolve-adapter': ['[--config <registry.json>] [--out <resolution.json>]', 'theme-capabilities', 'validateAdapterRegistryConfig'],
  'verify-business': ['[--config <business-import.json>] [--out <verification.json>]', 'business-evidence', 'validateBusinessConfig'],
  'audit-policy': ['[--config <policy-audit.json>] [--out <audit.json>]', 'policy-audit', 'validatePolicyConfig'],
  'audit-window-budget': ['[--config <window-budget.json>] [--out <budget.json>]', 'resource-budget', 'validateWindows'],
  'field-monitor': ['--config <field-monitor.json> --out <monitor-run-directory>', 'field-monitor', 'validateMonitorConfig'],
  'strategy-contract': ['[--config <strategy-contract.json>] [--out <contract.json>]', 'strategy-contract', 'validateStrategyConfig'],
  'request-implementation': '--previous <session.json> --candidate <candidateId> [--files <paths.json>] --out <request.json>',
  'plan-custom': '--request <request.json> --candidate <implementation.json> --out <plan.json>',
  'sync-shopify-docs': ['[--config <bounded-sync.json>] --out <NEW-directory>', 'shopify-docs', 'validateDocsSyncConfig'],
  'shopify-methods': '[--sources <refreshed-sources.json>] [--topic <images|liquid|css|fonts|javascript|apps|delivery|mobile|measurement|platform|external>] [--out <methods.json>]',
  'plan-official': ['--project <theme> --config <official-method.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] [--sources <sources.json>] --out <plan.json>', 'official-plan', 'validateOfficialPlanConfig'],
  'improve': ['--config <start-or-resume-step.json> --out <NEW-directory>', 'improvement-config', 'validateImprovementInput'],
  'improve-cycle': ['--config <reviewed-recovery-options.json> --out <NEW-directory>', 'recovery-cycle', 'validateRecoveryCycleConfig'],
  'doctor': '',
  'import-field': '--input <normalized-export.json|summary.csv|crux.json> [--out <field.json>]',
  'audit-stylesheets': '--project <theme> [--out <stylesheet-audit.json>]',
  'attribute-apps': '--profiles <profile-paths.json> [--owners <reviewed-owners.json>] [--out <apps.json>]',
  'measure-interactions': ['--config <interaction-measurement.json> --out <NEW-directory>', 'interaction-measure', 'validateInteractionConfig'],
  'verify-interactions': ['--config <interaction-comparison.json> [--out <interaction-gain.json>]', 'verification-config', 'validateInteractionComparison'],
  'ci-check': ['--config <explicit-baseline-and-candidate.json> [--out <ci.json>]', 'ci-check', 'validateCIConfig'],
  'source-graph': '--project <theme> [--out <graph.json>]',
  'diagnose-performance': '--project <theme> [--profiles <profile-paths.json>] [--run <run>] [--liquid <profile.json>] [--field <field.json>] [--owners <owners.json>] [--goal <goal.json>] [--limit <1..20>] [--checks <check-import.json>] [--ownership <ownership.json>] [--performance-baseline <performance.json>] [--out <diagnosis.json>]',
  'plan-demand': ['--project <theme> --config <demand.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] [--out <plan.json>]', 'demand-plan', 'validateDemandConfig'],
  'plan-domain': ['--project <theme> --config <domain-plan.json> --diagnosis <diagnosis.json> [--profiles <profile-paths.json>] [--out <plan.json>]', 'domain-plan', 'validateDomainPlanConfig'],
  'profile-domain': ['--config <domain-profile.json> --out <new-directory>', 'domain-profile', 'validateDomainProfileConfig'],
  'experiment-liquid': ['--config <liquid-pair.json> --out <new-directory>', 'liquid-experiment', 'validateLiquidExperimentConfig'],
  'verify-patch': ['--config <patch-evidence.json> [--out <decision.json>]', 'verification-config', 'validatePatchVerification'],
  'verify-preservation': ['--config <checkpoint-evidence.json> [--out <preservation.json>]', 'verification-config', 'validatePreservationConfig'],
  'experiment': ['--config <single-patch-experiment.json> --out <NEW-directory>', 'patch-experiment', 'validateExperimentConfig'],
  'code-strategies': '[--out <strategies.json>]',
  'analyze-code': '--project <theme> --target <relative-JS-CSS-Liquid-file> [--out <code-analysis.json>]',
  'audit-runtime-integrity': '--input <profile.json> --out <integrity.json>',
  'profile-runtime': ['--config <runtime.json> --out <NEW-directory>', 'runtime-profile', 'validateProfileConfig'],
  'profile-devtools': ['--config <devtools.json> --out <NEW-directory>', 'devtools-profile', 'validateDevtoolsConfig'],
  'profile-liquid': ['--config <liquid-profile.json> [--out <profile.json>]', 'liquid-profile', 'validateLiquidProfileConfig'],
  'verify-deployment': ['--config <deployment-with-pages.json> [--out <proof.json>]', 'deployment', 'validateDeploymentRequest'],
  'verify-gain': '--before <run> --after <run> [--goal <goal.json>] [--out <gain.json>]',
  'verify-optimization': ['--config <verification.json> [--out <decision.json>]', 'verification-config', 'validateFormalVerification'],
  'plan-split': ['--project <theme> --config <split.json> [--out <plan.json>]', 'split-plan', 'validateSplitConfig'],
  'optimize': ['--config <prepare-apply-or-verify.json> --out <NEW-directory>', 'optimization-config', 'validateOptimizationConfig'],
  'report-pdf': ['--config <report-config.json> --out <new-absolute-directory>', 'pdf-report', 'validatePdfConfig'],
  'scan': '--project <theme> [--pages <URLs.json>] [--out <site-scan.json>]',
  'precheck': ['--project <theme> [--config <precheck-options.json>] [--out <precheck.json>]', 'precheck', 'validatePrecheck'],
  'check-performance': ['--project <theme> [--config <official-options.json>] [--out <official-checks.json>]', 'official-performance', 'validateOfficialPerformance'],
  'check-theme': '--project <theme> --out <project-checks.json>',
  'plan-sampling': '--audit <performance-audit.json> --finding <finding-id> --url <page-url> [--device <both|mobile|desktop>] [--selector <instance-selector>] [--theme-id <id>] [--store <store.myshopify.com>] [--settle-ms <0..10000>] --out <NEW-directory>',
  'plan-verification': ['--config <source-manifests-and-scope.json> --out <verification-plan.json>', 'standards-policy', 'verificationPlan'],
  'import-pageotter': '--input <handoff-v1.json> [--project <theme>] [--baseline <prior-import.json>] --out <import.json>',
  'audit-performance': '--project <theme> [--profiles <runtime-profile-array.json>] [--baseline <performance.json>] [--checks <check-import.json>] [--ownership <ownership.json>] [--out <performance.json>]',
  'import-check': '--project <theme> --input <theme-check.json> [--metadata <scan-contract.json>] [--baseline <prior-import.json>] [--out <check-import.json>]',
  'audit-resources': '--project <theme> [--probe <true|false>] [--out <resource-audit.json>]',
  'plan-resource-repair': ['--project <theme> --config <approved-image-repair.json> --profile <deployment-bound-profile.json> [--out <plan.json>]', 'resource-repair', 'validateResourceRepairConfig'],
  'verify-resource-repair': ['--config <plan-before-after-profiles.json> [--out <repair-verification.json>]', 'verification-config', 'validateResourceVerification'],
  'theme-diff': '--before <baseline-theme> --after <candidate-theme> --out <diff.json>',
  'audit-quality': '--project <theme> [--checks <check-import.json>] [--out <quality.json>]',
  'audit-html': '--input <absolute-rendered.html> [--fragment <true|false>] [--lcp-id <trace-identified-img-id>] --out <html-audit.json>',
  'map': '--project <theme> [--target <file>] --capture <capture.json> [--out <mapping.json>]',
  'scenarios': ['--config <scenarios.json> --out <NEW-directory>', 'scenarios', 'validateScenarioConfig'],
  'measure': ['--config <measurement.json> --out <NEW-run-directory> [--progress <quiet|group|attempt>]', 'measure', 'validateMeasureConfig'],
  'batch': ['--config <batch.json> --out <NEW-directory>', 'batch', 'validateBatchConfig'],
  'summarize': '--run <measurement-directory> [--out <summary.json>]',
  'evaluate-iteration': ['--config <history.json> [--out <decision.json>]', 'iteration', 'validateIterationConfig'],
  'audit-site': '--project <theme> --run <measurement-directory> [--checks <check-import.json>] [--official <official>] [--resources <resource-audit.json>] [--runtime <runtime>] [--precheck <precheck>] [--ownership <ownership.json>] [--performance-baseline <performance.json>] [--html-audits <saved-html-audits.json>] [--out <site-audit.json>]',
  'plan-site': '--project <theme> --recipe <reviewed-recipe.json> [--out <site-plan.json>]',
  'verify-site': '--before <baseline-run> --after <candidate-run> [--thresholds <thresholds.json>] [--out <site-verification.json>]',
  'inspect': '--project <theme> --target <relative-file> [--capture <capture.json>] [--out <inspection.json>]',
  'plan-image': "--project <theme> --target <relative-file> [--inspection <inspection>] [--image 0] --sizes '<CSS sizes>' --widths 320,640,900 [--out <plan.json>]",
  'plan-component': "--project <theme> --target assets/file.js --replacement <reviewed-file> --rule CMP03 --reason '<why>' [--validators <validators>] [--out <plan.json>]",
  'apply': '--project <theme> --plan <plan.json> [--out <receipt.json>] [--adapter-context <adapter-context>]',
  'rollback': '--project <theme> --plan <plan.json> [--out <receipt.json>]',
  'capture': "--url <http-url> --selector '<unique-selector>' --out <NEW-directory> [--width 390] [--height 844] [--dpr 1] [--wait-ms 1500] [--timeout-ms 30000] [--project <project>] [--target <target>]",
  'verify': '--before <capture.json> --after <capture.json> [--out <comparison.json>]',
  'report': '--input <inspection/capture/comparison.json> --out <report.html>',
  'lighthouse': '--before <five-LHR-directory> [--after <five-LHR-directory>] [--out <summary.json>]',
  'score-target': '--before <five-LHR-directory> --after <five-LHR-directory> [--minimum <score>] [--target <median-score>] [--out <new-target.json>]',
  'validate-config': '--command <command> --config <config.json>',
};

const footer = `Default: one agent, bounded JSON console summaries (4 KiB), quiet batch/measurement progress.
Use --format full for complete stdout, or --out to save full JSON without feeding it to the model.
All output paths must be new, except improve action=recover seals its original interrupted directory.
scan/audit/inspect/plan/capture do not change theme files.
apply/rollback accept both single-file and site-change plans; site writes are preflighted, not a filesystem transaction.
measure runs real Lighthouse or PSI against explicit URLs, sequentially. It executes normal page requests.
Install pinned dependencies with npm ci; local measurement discovers installed Chrome or accepts PERF_KIT_BROWSER_EXECUTABLE / CHROME_PATH. PSI needs a publicly accessible URL.
Browser capture includes Playwright Core; optionally set PERF_KIT_PLAYWRIGHT_MODULE to an existing absolute module path.
Optional PERF_KIT_BROWSER_EXECUTABLE selects an installed Chromium executable.
Exit: 0 completed, 2 invalid input/execution, 3 diagnostic mismatch or score target failed/review required, 4 missing browser dependency.
score-target defaults: mobile minimum 75 / median 80; desktop minimum 85 / median 90. Imports reports; does not run Lighthouse.
Capture and verify are bounded diagnostics, not a release or CWV pass. No push/publish commands.
`;

const optionPattern = /(\[)?--([a-z-]+) (<[^>]+>|'[^']+'|[^\s\]]+)\]?/g;
const commands = new Map(Object.entries(definitions).map(([name, definition]) => {
  const [usage, module, validator] = Array.isArray(definition) ? definition : [definition];
  const options = new Map([...usage.matchAll(optionPattern)].map(([, optional, key, hint]) => [key, {
    required: !optional,
    hint,
    values: /^<[a-z]+(?:\|[a-z]+)+>$/.test(hint) ? hint.slice(1, -1).split('|') : undefined,
  }]));
  return [name, {usage, options, module, validator}];
}));
const supportedConfigs = [...commands].filter(([, command]) => command.validator).map(([name]) => name);
const formats = ['summary', 'full'];
const helpFlags = ['--help', '-h'];

export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help', ...helpFlags].includes(command)) {
    if (command === 'help' && rest.length && !helpFlags.includes(rest[0])) {
      if (!commands.has(rest[0])) throw new Error('Unknown command: ' + rest[0] + '. See --help.');
      return {help: true, command: rest[0]};
    }
    return {help: true};
  }
  const definition = commands.get(command);
  if (!definition) throw new Error('Unknown command: ' + command + '. See --help.');
  if (rest.length === 1 && helpFlags.includes(rest[0])) return {help: true, command};
  const options = new Map(definition.options);
  options.set('format', {hint: '<summary|full>', values: formats});
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    const option = options.get(key);
    if (!option) throw new Error('Unknown option: ' + flag + ' for ' + command + '. Allowed: ' + [...options.keys()].map(k => '--' + k).join(', ') + '.');
    if (Object.hasOwn(args, key)) throw new Error('Duplicate option: --' + key + '.');
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --' + key + '. Expected ' + option.hint + '.');
    if (option.values && !option.values.includes(value)) throw new Error('--' + key + ' must be one of: ' + option.values.join(', ') + '.');
    args[key] = value;
  }
  for (const [key, option] of options) {
    if (option.required && !args[key]) throw new Error('Required: --' + key + ' ' + option.hint + '. See ' + command + ' --help.');
  }
  return {command, args};
}

export function commandHelp(version, command) {
  const heading = 'Shopify Perf Toolkit ' + version + ' (Node 22+, offline core)';
  if (command) {
    const definition = commands.get(command);
    const lines = [heading, ['Usage: perfkit', command, definition.usage, '[--format <summary|full>]'].filter(Boolean).join(' ')];
    if (command === 'improve') lines.push('For action=recover, use the original interrupted directory for --out.');
    if (command === 'validate-config') lines.push('Supported commands: ' + supportedConfigs.join(', '));
    if (definition.validator) lines.push('Config check: perfkit validate-config --command ' + command + ' --config <config.json>');
    return lines.join('\n');
  }
  return [heading, ...[...commands].map(([name, {usage}]) => '  ' + [name, usage].filter(Boolean).join(' ')),
    'Use perfkit <command> --help for command-specific usage.', footer].join('\n');
}

export function configValidator(command) {
  const definition = commands.get(command);
  if (!definition?.validator) {
    const error = new Error('--command must name a command with offline config validation. Allowed: ' + supportedConfigs.join(', ') + '.');
    throw Object.assign(error, {code: 'INVALID_CONFIG_COMMAND'});
  }
  return async config => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw Object.assign(new Error('config must be a JSON object.'), {code:'INVALID_CONFIG'});
    }
    const module = await import('../lib/' + definition.module + '.mjs');
    return module[definition.validator](config);
  };
}
