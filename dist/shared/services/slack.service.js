import { WebClient } from "@slack/web-api";
export class SlackService {
    constructor(config) {
        this.webClient = new WebClient(config.token);
        this.channel = config.channel;
    }
    async postMessage(blocks, text) {
        await this.webClient.chat.postMessage({
            channel: this.channel,
            blocks,
            text,
        });
    }
}
