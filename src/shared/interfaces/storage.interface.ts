export interface IStorage {
    stageFilesFromStorage(): Promise<void>;
    uploadArtifacts(): Promise<void>;
    unzipToStaging(zipFilePath: string, outputDir: string): Promise<boolean>;
}
