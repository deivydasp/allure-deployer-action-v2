export interface GithubPagesInterface {
    branch: string;
    owner: string;
    repo: string;
    deployPages(): Promise<void>;
    setupBranch(): Promise<any>;
}