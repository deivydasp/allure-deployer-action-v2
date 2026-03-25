import type { Block, KnownBlock, WebClient } from '@slack/web-api';

export interface SlackInterface {
    webClient: WebClient;
    channel: string;
    postMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void>;
}

export interface SlackConfig {
    token: string;
    channel: string;
}
