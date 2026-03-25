export interface HostingProvider {
    init(): Promise<string>;
    deploy(): Promise<void>;
}
