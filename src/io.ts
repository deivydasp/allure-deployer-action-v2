import {DefaultConfig, input, Inputs} from "./interfaces/inputs.interface.js";
import * as core from "@actions/core";
import path from "node:path";
import os from "node:os";

function getInput<T extends input>(
    name: T, required: boolean = false,
): Inputs[T] {
    return core.getInput(name, {required}) as Inputs[T];
}
function getBooleanInput<T extends input>(
    name: T, required: boolean = false,
): boolean {
    return core.getBooleanInput(name, {required});
}

function getInputOrUndefined<T extends input>(name: T): Inputs[T] | undefined {
    const data = core.getInput(name);
    if(data === ''){
        return undefined;
    } else {
        return data as Inputs[T]
    }
}

const inputs : Inputs & DefaultConfig = {
    language: getInput('language'),
    report_name: getInputOrUndefined('report_name'),
    custom_report_dir: core.getInput('report_dir') || getInputOrUndefined('custom_report_dir'),
    allure_results_path: getInput('allure_results_path', true),
    retries : getInput('retries'),
    show_history: getBooleanInput('show_history'),
    github_token: getInput('github_token', true),
    github_pages_branch: getInputOrUndefined('github_pages_branch'),
    github_pages_repo: getInput('github_pages_repo'),
    pr_comment: getBooleanInput('pr_comment'),
    slack_channel: getInput('slack_channel'),
    slack_token: getInput('slack_token'),
    keep: getInput('keep'),
    prefix: prefix(),
    fileProcessingConcurrency: 10,
    RESULTS_STAGING_PATH: path.posix.join(runtimeDir(), "allure-results"),
    ARCHIVE_DIR: path.posix.join(runtimeDir(), "archive"),
    WORKSPACE: workspace(),
};

function replaceWhiteSpace(s: string, replaceValue = '-'): string {
    return s.replace(/\s+/g, replaceValue)
}

function prefix(): string | undefined {
    let prefix = core.getInput('gh_artifact_prefix')
    if(!prefix){ // if empty string
        prefix = core.getInput('prefix')
    }
    return  prefix ? replaceWhiteSpace(prefix) : undefined;
}

function workspace(): string{
    return path.posix.join(runtimeDir(), 'report');
}
function runtimeDir(): string{
    return path.posix.join(os.tmpdir(), 'allure-report-deployer');
}


export default inputs
