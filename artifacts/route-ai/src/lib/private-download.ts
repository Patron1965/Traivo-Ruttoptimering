/** Keep download authentication identical to generated/raw API calls, including
 * the immutable operational workspace header. Never navigate to a cookie-only
 * download URL from an operational workspace. */
export async function downloadPrivateFile(path: string, name: string) {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error("Filen kunde inte hämtas. Kontrollera din åtkomst och försök igen.");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}