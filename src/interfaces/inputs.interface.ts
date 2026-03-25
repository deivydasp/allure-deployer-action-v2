export interface Inputs{
    github_token: string;
    github_pages_branch?: string;
    github_pages_repo: string;
    report_name?: string
    slack_channel: string
    slack_token: string
    allure_results_path: string
    retries: number;
    show_history: boolean;
    pr_comment: boolean;
    custom_report_dir?: string;
    language: string;
    keep: number;
    prefix?: string;
}
export interface DefaultConfig {
    fileProcessingConcurrency: 10,
    RESULTS_STAGING_PATH: string,
    ARCHIVE_DIR: string,
    WORKSPACE: string
}
export type input = keyof Inputs
