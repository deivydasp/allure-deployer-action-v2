export interface GithubInterface {
    updateOutput({ name, value }: { name: string; value: string }): Promise<void>;
    updateSummary(message: string): Promise<void>;
    /**
     * Posts the report comment on a pull request and deletes earlier ones carrying the same
     * `commentKey`: each run notifies the PR's participants and leaves a single comment per report.
     */
    updatePr({
        message,
        token,
        prNumber,
        commentKey,
    }: {
        message: string;
        token: string;
        prNumber: number;
        commentKey: string;
    }): Promise<void>;
}
