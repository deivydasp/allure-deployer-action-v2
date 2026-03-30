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
    getFiles(params: { matchGlob?: string; order?: Order; maxResults?: number }): Promise<StorageFile[]>;
    download(params: { destination: string; concurrency?: number; files: StorageFile[] }): Promise<string[]>;
    deleteFile(file: number | string): Promise<void>;
    uploadFile(absoluteFilePath: string, rootDir: string, destination: string): Promise<void>;
}
