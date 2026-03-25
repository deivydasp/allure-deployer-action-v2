export interface GithubInterface {
    updateOutput({ name, value }: { name: string; value: string }): Promise<void>;
    updateSummary(message: string): Promise<void>;
    updatePr({ message, token, prNumber }: { message: string; token: string; prNumber: number }): Promise<void>;
}
