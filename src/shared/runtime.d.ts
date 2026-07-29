// The shared core compiles with lib ES2022 and no DOM/Node ambient types, so
// any platform-specific global is a compile error. These are the only runtime
// globals shared code may touch — each exists in both the desktop extension
// host (Node >= 22 as of VS Code 1.125) and the web worker extension host.
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function btoa(data: string): string;
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
