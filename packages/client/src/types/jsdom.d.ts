declare module "jsdom" {
  export type DOMWindow = Window &
    typeof globalThis & {
      close(): void;
    };

  export type ConstructorOptions = {
    runScripts?: "dangerously" | "outside-only";
    url?: string;
  };

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: DOMWindow;
  }
}
