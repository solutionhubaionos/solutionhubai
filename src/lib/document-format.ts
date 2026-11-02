export type DocumentFormat = "pdf" | "docx" | "pptx" | "image" | "video" | "unsupported";
export function documentFormat(name: string, mime = ""): DocumentFormat {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp)$/.test(extension ?? "")) return "image";
  if (mime.startsWith("video/") || /^(mp4|webm|mov)$/.test(extension ?? "")) return "video";
  return "unsupported";
}