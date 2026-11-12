/** Decode and re-encode browser photos before storing them in the offline queue.
 * Unsupported/corrupt files fail here, not hours later during replay.
 */
export async function prepareBrowserPhoto(file: File): Promise<string> {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("PHOTO_SIZE");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 80_000_000) throw new Error("PHOTO_SIZE");
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PHOTO_DECODE");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.82);
    if (!data.startsWith("data:image/jpeg;base64,") || data.length > 4_000_000) throw new Error("PHOTO_SIZE");
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
