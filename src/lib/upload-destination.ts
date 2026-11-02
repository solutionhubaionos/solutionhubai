export function uploadDestination(fixedIndustry: string | undefined, selectedIndustry: string, scope: string, customer: string) {
  const industry = fixedIndustry || selectedIndustry;
  if (!industry) throw new Error("Choose an industry");
  const name = customer.trim().replace(/\s+/g, " ");
  if (scope === "company" && !name) throw new Error("Choose or enter a company");
  return { industry, customer_name: scope === "company" ? name : null };
}