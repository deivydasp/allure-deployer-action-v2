export enum Order {
    byOldestToNewest = 0,
    byNewestToOldest = 1,
}

export interface StorageProvider {
    bucket: any;
    prefix: string | undefined;
    upload(filePath: string, destination: string): Promise<void>;
    getFiles(params: {
        matchGlob?: any;
        order?: Order;
        maxResults?: number;
        endOffset?: string;
    }): Promise<any[]>;
    download(params: {
        destination: string;
        concurrency?: number;
        files: any[];
    }): Promise<any[]>;
    deleteFiles(matchGlob?: any): Promise<void>;
    deleteFile(file: any): Promise<void>;
    sortFiles(files: any[], order: Order): any[];
}
