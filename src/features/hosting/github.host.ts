import { GithubPagesInterface } from '../../interfaces/github-pages.interface.js';
import { HostingProvider } from '../../shared/index.js';

export class GithubHost implements HostingProvider {
    constructor(readonly client: GithubPagesInterface) {}
    async deploy(): Promise<void> {
        await this.client.deployPages();
    }

    async init(): Promise<string> {
        return await this.client.setupBranch();
    }
}
