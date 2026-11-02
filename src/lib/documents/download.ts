/**
 * Turns the server's base64 payload into a browser download. Client-only — it
 * touches Blob and the DOM — so it lives apart from both the card component and
 * the server-side renderers.
 */
import type { GeneratedDocument } from "./types";

export function downloadDocument(file: GeneratedDocument) {
  const binary = globalThis.atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
