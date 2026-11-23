declare module "pako" {
  class Inflate {
    constructor(options: { chunkSize: number; windowBits: number });
    readonly ended: boolean;
    readonly err: number;
    readonly strm: { readonly avail_in: number };
    onData(chunk: Uint8Array): void;
    push(data: Uint8Array, finish: boolean): boolean;
  }
  const pako: { Inflate: typeof Inflate };
  export default pako;
}
