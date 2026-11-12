import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import sv from "../../i18n/locales/sv.json";
import { OptimizationProgressCard } from "./OptimizationProgressCard";

async function renderStatus(status: "starting" | "running" | "reconnecting") {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "sv",
    resources: { sv: { translation: sv } },
    initImmediate: false,
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <OptimizationProgressCard
        phase={status === "starting" ? "preparing" : "optimizing"}
        status={status}
        stopCount={228}
        resourceCount={7}
        objectiveLabel="Geografiska områden"
        elapsedMs={status === "starting" ? null : 45_000}
        estimatedRemainingMs={null}
        onRetry={() => undefined}
      />
    </I18nextProvider>,
  );
}

test("registration waiting does not claim lost contact or active server work", async () => {
  const html = await renderStatus("starting");
  assert.match(html, /Förbereder optimeringen/);
  assert.match(html, /Förfluten tid: inväntar servern/);
  assert.doesNotMatch(html, /animate-spin|role="alert"/);
});

test("delayed status is explicit without claiming a broken connection or spinning", async () => {
  const html = await renderStatus("reconnecting");
  assert.match(html, /Optimeringen kan fortfarande pågå/);
  assert.match(html, /utan att starta om körningen/);
  assert.match(html, /Kontrollera status/);
  assert.doesNotMatch(html, /animate-spin|Kontakten med servern är tillfälligt bruten/);
});

test("fresh active work has an activity indicator and server-anchored elapsed time", async () => {
  const html = await renderStatus("running");
  assert.match(html, /animate-spin/);
  assert.match(html, /0 min 45 s/);
  assert.match(html, /Förbättrar rutterna/);
  assert.doesNotMatch(html, /role="alert"/);
});