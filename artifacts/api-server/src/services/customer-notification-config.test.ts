import { test } from "node:test";
import assert from "node:assert/strict";
import { customerNotificationConfigSchema, escapeNotificationHtml, renderNotification } from "./customer-notification-config";
const event = {enabled:true, sms:"Hej {{customer_name}}", subject:"Leverans", email:"{{address}}"};
test("three event config rejects invalid channel, fields, blank active messages and overlong templates", () => {
  const config = {channel:"both",events:{planned:event,approaching:event,completed:event}};
  assert.equal(customerNotificationConfigSchema.safeParse(config).success,true);
  for (const bad of [
    {...config,channel:"twilio"},
    {...config,events:{...config.events,planned:{...event,sms:"{{secret}}"}}},
    {...config,events:{...config.events,planned:{...event,email:" "}}},
    {...config,events:{...config.events,planned:{...event,subject:"x".repeat(201)}}},
  ]) assert.equal(customerNotificationConfigSchema.safeParse(bad).success,false);
});
test("substitutions do not execute nested template input or HTML", () => {
  assert.equal(renderNotification("Hej {{customer_name}} {{tracking_url}}", {customer_name:"{{company}}"}),"Hej {{company}} ");
  assert.equal(escapeNotificationHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");
});
