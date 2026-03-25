import { DefaultConfig, input, Inputs } from './interfaces/inputs.interface.js';
import { getInput, getBooleanInput } from '@actions/core';
import path from 'node:path';
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
    language: getTypedInput('language'),
    report_name: getInputOrUndefined('report_name'),
    custom_report_dir: getInput('report_dir') || getInputOrUndefined('custom_report_dir'),
    allure_results_path: getTypedInput('allure_results_path', true),
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

function replaceWhiteSpace(s: string, replaceValue = '-'): string {
    return s.replace(/\s+/g, replaceValue);
}

function prefix(): string | undefined {
    let prefix = getInput('gh_artifact_prefix');
    if (!prefix) {
        prefix = getInput('prefix');
    }
    return prefix ? replaceWhiteSpace(prefix) : undefined;
}

function workspace(): string {
    return path.join(runtimeDir(), 'report');
}
function runtimeDir(): string {
    return path.join(os.tmpdir(), 'allure-report-deployer');
}

export default inputs;
