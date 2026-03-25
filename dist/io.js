import { getInput, getBooleanInput } from '@actions/core';
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
    language: getTypedInput('language'),
    report_name: getInputOrUndefined('report_name'),
    custom_report_dir: getInput('report_dir') || getInputOrUndefined('custom_report_dir'),
    allure_results_path: getTypedInput('allure_results_path', true),
    retries: Number(getTypedInput('retries')),
    show_history: getBooleanInput('show_history'),
    github_token: getTypedInput('github_token', true),
    github_pages_branch: getInputOrUndefined('github_pages_branch'),
    github_pages_repo: getTypedInput('github_pages_repo'),
    pr_comment: getBooleanInput('pr_comment'),
    slack_channel: getTypedInput('slack_channel'),
    slack_token: getTypedInput('slack_token'),
    keep: Number(getTypedInput('keep')),
    prefix: prefix(),
    fileProcessingConcurrency: 10,
    RESULTS_STAGING_PATH: path.join(runtimeDir(), 'allure-results'),
    ARCHIVE_DIR: path.join(runtimeDir(), 'archive'),
    WORKSPACE: workspace(),
};
function replaceWhiteSpace(s, replaceValue = '-') {
    return s.replace(/\s+/g, replaceValue);
}
function prefix() {
    let prefix = getInput('gh_artifact_prefix');
    if (!prefix) {
        prefix = getInput('prefix');
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
