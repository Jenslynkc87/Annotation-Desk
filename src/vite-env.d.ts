/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
declare module 'mammoth/mammoth.browser.js' {
  const mammoth: { extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  export default mammoth;
}
