export type AppRole = "admin" | "member";

export function roleFromRows(rows: { role: string }[]): AppRole {
  return rows.some((row) => row.role === "admin") ? "admin" : "member";
}

export function canManageContent(role: AppRole, userId: string, uploadedBy: string) {
  return role === "admin" || userId === uploadedBy;
}