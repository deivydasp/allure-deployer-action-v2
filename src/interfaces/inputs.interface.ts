export interface Inputs {
    mode: 'deploy' | 'summary';
    summary: boolean;
    prefixes?: string;
    github_token: string;
    github_pages_branch?: string;
    github_pages_repo: string;
    report_name?: string;
    allure_results_path?: string;
    show_history: boolean;
    pr_comment: boolean;
    custom_report_dir?: string;

    language?: string;
    keep: number;
    prefix?: string;
}
export interface DefaultConfig {
    fileProcessingConcurrency: 10;
    RESULTS_STAGING_PATH: string;
    ARCHIVE_DIR: string;
    HISTORY_PATH: string;
    WORKSPACE: string;
}
export type input = keyof Inputs;
