import { getInput, getBooleanInput, setSecret } from '@actions/core';
import path from 'node:path';
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
    prefix: prefix(),
    fail_on_test_failure: getInput('fail_on_test_failure') === 'true',
    fileProcessingConcurrency: 10,
    RESULTS_STAGING_PATH: path.join(runtimeDir(), 'allure-results'),
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
function workspace() {
    return path.join(runtimeDir(), 'report');
}
function runtimeDir() {
    return path.join(os.tmpdir(), 'allure-report-deployer');
}
export default inputs;
