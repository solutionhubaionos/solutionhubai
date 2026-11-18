export type DocumentFormat = "pdf" | "docx" | "pptx" | "xlsx" | "image" | "video" | "unsupported";
export function documentFormat(name: string, mime = ""): DocumentFormat {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (
    extension === "xlsx" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "xlsx";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp)$/.test(extension ?? "")) return "image";
  if (mime.startsWith("video/") || /^(mp4|webm|mov)$/.test(extension ?? "")) return "video";
  return "unsupported";
}
