import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  const base = (process.env.EXPO_PUBLIC_WEB_BASE_PATH ?? "/").replace(/\/?$/, "/");
  return (
    <html lang="sv">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#164B3B" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <link rel="manifest" href={`${base}driver.webmanifest`} />
        <link rel="apple-touch-icon" href={`${base}driver-icon.png`} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
