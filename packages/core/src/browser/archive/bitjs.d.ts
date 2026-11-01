declare module '@codedread/bitjs' {
  interface Unarchiver {
    addEventListener(event: 'extract', handler: (e: Event) => void): void;
    addEventListener(event: 'finish', handler: (e: Event) => void): void;
    addEventListener(event: 'error', handler: (e: Event) => void): void;
    start(): void;
    stop(): void;
  }

  function getUnarchiver(buffer: ArrayBuffer, options?: Record<string, unknown>): Unarchiver | null;
}

declare module '@codedread/bitjs/archive/unrar.js' {
  export function connect(port: MessagePort): void;
  export function disconnect(): void;
}
