export class GithubHost {
    client;
    constructor(client) {
        this.client = client;
    }
    async deploy() {
        await this.client.deployPages();
    }
    async init() {
        return await this.client.setupBranch();
    }
}
