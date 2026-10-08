// Ambient types for `dockerode` (owner: agent 1).
//
// The project ships no @types/dockerode and must not add dependencies, so the foundation declares
// the surface this layer uses. Runtime resolution is unaffected — this file is types only.

declare module 'dockerode' {
  export interface DockerOptions {
    socketPath?: string;
    host?: string;
    port?: number;
    protocol?: 'http' | 'https' | 'ssh';
    cert?: string;
    key?: string;
    ca?: string;
    timeout?: number;
    version?: string;
  }

  export interface DockerContainer {
    id: string;
    inspect(): Promise<any>;
    start(opts?: any): Promise<any>;
    stop(opts?: any): Promise<any>;
    restart(opts?: any): Promise<any>;
    kill(opts?: any): Promise<any>;
    pause(): Promise<any>;
    unpause(): Promise<any>;
    remove(opts?: any): Promise<any>;
    logs(opts?: any): Promise<any>;
    stats(opts?: any): Promise<any>;
    exec(opts?: any): Promise<any>;
  }

  export interface DockerImage {
    inspect(): Promise<any>;
    remove(opts?: any): Promise<any>;
  }

  export interface DockerVolume {
    inspect(): Promise<any>;
    remove(opts?: any): Promise<any>;
  }

  export interface DockerNetwork {
    inspect(): Promise<any>;
    remove(opts?: any): Promise<any>;
  }

  export default class Docker {
    constructor(opts?: DockerOptions);
    ping(): Promise<any>;
    version(): Promise<any>;
    info(): Promise<any>;
    listContainers(opts?: any): Promise<any[]>;
    createContainer(opts?: any): Promise<DockerContainer>;
    getContainer(id: string): DockerContainer;
    getImage(name: string): DockerImage;
    getVolume(name: string): DockerVolume;
    getNetwork(id: string): DockerNetwork;
    listImages(opts?: any): Promise<any[]>;
    pull(ref: string, opts?: any): Promise<any>;
    createVolume(opts?: any): Promise<any>;
    listVolumes(opts?: any): Promise<any>;
    pruneVolumes(opts?: any): Promise<any>;
    createNetwork(opts?: any): Promise<any>;
    listNetworks(opts?: any): Promise<any[]>;
    pruneContainers(opts?: any): Promise<any>;
    pruneImages(opts?: any): Promise<any>;
    modem: any;
  }
}
