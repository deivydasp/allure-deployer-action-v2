import { getInput, getBooleanInput, setSecret, warning } from '@actions/core';
import { join } from 'node:path';
import os from 'node:os';
function getTypedInput(name, required = false) {
    return getInput(name, { required });
}
function getInputOrUndefined(name) {
    const data = getInput(name);
    if (data === '') {
        return undefined;
    }
    else {
        return data;
    }
}
const inputs = {
    mode: (getInput('mode') || 'deploy'),
    summary: getInput('summary') !== 'false',
    prefixes: getInputOrUndefined('prefixes'),
    language: getInputOrUndefined('language'),
    report_name: getInputOrUndefined('report_name'),
    custom_report_dir: getInputOrUndefined('custom_report_dir'),
    allure_results_path: getInputOrUndefined('allure_results_path'),
    show_history: getBooleanInput('show_history'),
    github_token: getTypedInput('github_token', true),
    github_pages_branch: getInputOrUndefined('github_pages_branch'),
    github_pages_repo: getTypedInput('github_pages_repo'),
    pr_comment: getBooleanInput('pr_comment'),
    keep: Math.max(1, Number(getTypedInput('keep')) || 10),
    commit_retention_days: commitRetentionDays(),
    prefix: prefix(),
    fail_on_test_failure: getInput('fail_on_test_failure') === 'true',
    fileProcessingConcurrency: 10,
    RESULTS_STAGING_PATH: join(runtimeDir(), 'allure-results'),
    WORKSPACE: workspace(),
};
if (inputs.github_token)
    setSecret(inputs.github_token);
function replaceWhiteSpace(s, replaceValue = '-') {
    return s.replace(/\s+/g, replaceValue);
}
function prefix() {
    let prefix = getInput('prefix');
    if (!prefix) {
        prefix = getInput('gh_artifact_prefix');
    }
    return prefix ? replaceWhiteSpace(prefix) : undefined;
}
/** Non-negative whole number of days; anything else disables pruning with a warning instead of guessing */
function commitRetentionDays() {
    const raw = String(getTypedInput('commit_retention_days')).trim();
    if (raw === '')
        return 0;
    if (!/^\d+$/.test(raw)) {
        warning(`Invalid commit_retention_days '${raw}': expected a non-negative whole number of days. Pruning is disabled.`);
        return 0;
    }
    return Number(raw);
}
function workspace() {
    return join(runtimeDir(), 'report');
}
function runtimeDir() {
    return join(os.tmpdir(), 'allure-report-deployer');
}
export default inputs;
