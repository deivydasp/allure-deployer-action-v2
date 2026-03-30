export interface IStorage {
    stageFilesFromStorage(): Promise<void>;
    uploadArtifacts(): Promise<void>;
}
