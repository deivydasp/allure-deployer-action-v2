import { DefaultConfig, input, Inputs } from './interfaces/inputs.interface.js';
import { getInput, getBooleanInput, setSecret } from '@actions/core';
import { join } from 'node:path';
import os from 'node:os';

function getTypedInput<T extends input>(name: T, required: boolean = false): Inputs[T] {
    return getInput(name, { required }) as Inputs[T];
}

function getInputOrUndefined<T extends input>(name: T): Inputs[T] | undefined {
    const data = getInput(name);
    if (data === '') {
        return undefined;
    } else {
        return data as Inputs[T];
    }
}

const inputs: Inputs & DefaultConfig = {
    mode: (getInput('mode') || 'deploy') as 'deploy' | 'summary',
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
    RESULTS_STAGING_PATH: join(runtimeDir(), 'allure-results'),
    WORKSPACE: workspace(),
};

if (inputs.github_token) setSecret(inputs.github_token);

function replaceWhiteSpace(s: string, replaceValue = '-'): string {
    return s.replace(/\s+/g, replaceValue);
}

function prefix(): string | undefined {
    let prefix = getInput('prefix');
    if (!prefix) {
        prefix = getInput('gh_artifact_prefix');
    }
    return prefix ? replaceWhiteSpace(prefix) : undefined;
}

function workspace(): string {
    return join(runtimeDir(), 'report');
}
function runtimeDir(): string {
    return join(os.tmpdir(), 'allure-report-deployer');
}

export default inputs;
