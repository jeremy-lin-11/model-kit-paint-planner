// Promise wrapper around the SAM worker.

import type { SamRequest, SamResponse } from "./sam.worker";

export interface MaskResult {
  width: number;
  height: number;
  /** 3 candidate masks back to back (small sub-part, part, whole), 1 byte per pixel. */
  masks: Uint8Array;
  scores: number[];
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class SamClient {
  private worker = new Worker(new URL("./sam.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<string>;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;

  constructor() {
    const files = new Map<string, { loaded: number; total: number }>();
    let readyResolve!: (device: string) => void, readyReject!: (e: Error) => void;
    this.readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    this.worker.onmessage = (e: MessageEvent<SamResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        files.set(msg.file, { loaded: msg.loaded, total: msg.total });
        let l = 0, t = 0;
        files.forEach((f) => { l += f.loaded; t += f.total; });
        this.onProgress?.(l, t);
      } else if (msg.type === "ready") {
        readyResolve(msg.device);
      } else if (msg.type === "error" && msg.id === undefined) {
        readyReject(new Error(msg.message));
      } else if ("id" in msg && msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === "error") p.reject(new Error(msg.message));
        else p.resolve(msg);
      }
    };
    this.send({ type: "load" });
  }

  private send(req: SamRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(req, transfer);
  }

  private call<T>(make: (id: number) => SamRequest, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(make(id), transfer);
    });
  }

  ready(): Promise<string> {
    return this.readyPromise;
  }

  async embed(rgba: Uint8ClampedArray, width: number, height: number): Promise<number> {
    await this.ready();
    const copy = rgba.slice().buffer;
    const res = await this.call<{ ms: number }>((id) => ({ type: "embed", id, width, height, rgba: copy }), [copy]);
    return res.ms;
  }

  async decode(points: { x: number; y: number; positive: boolean }[]): Promise<MaskResult> {
    return this.call<MaskResult>((id) => ({ type: "decode", id, points }));
  }
}
