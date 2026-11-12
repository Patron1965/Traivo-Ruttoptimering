/** Applied at runtime as Expo's single-page web output doesn't use +html. */
export function installDesktopPhoneFrame() {
  if (typeof document === "undefined") return;
  const id = "traivo-desktop-phone-frame";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    @media (min-width: 700px) {
      body { background: #e8eceb; }
      #root {
        width: 430px;
        max-width: 100%;
        height: 100%;
        margin-inline: auto;
        position: relative;
        isolation: isolate;
        transform: translateZ(0);
        overflow: hidden;
        box-shadow: 0 0 0 1px #cbd5d1, 0 0 36px #00000018;
      }
    }
  `;
  document.head.appendChild(style);
}
