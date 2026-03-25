export enum Order {
    byOldestToNewest = 0,
    byNewestToOldest = 1,
}

export interface StorageFile {
    id: number;
    name: string;
    created_at: string | null;
}

export interface StorageProvider {
    upload(filePath: string, destination: string): Promise<void>;
    getFiles(params: { matchGlob?: string; order?: Order; maxResults?: number }): Promise<StorageFile[]>;
    download(params: { destination: string; concurrency?: number; files: StorageFile[] }): Promise<string[]>;
    deleteFiles(matchGlob?: string): Promise<void>;
    deleteFile(file: number | string): Promise<void>;
    sortFiles(files: StorageFile[], order: Order): StorageFile[];
}
