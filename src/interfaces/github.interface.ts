export interface GithubInterface {
    updateOutput({ name, value }: { name: string; value: string }): Promise<void>;
    updateSummary(message: string): Promise<void>;
    /**
     * Posts the report comment on a pull request, or edits the earlier one carrying the same
     * `commentKey`, so repeated runs on one PR keep a single comment per report.
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
