// just scenario <name>|all : runs scenarios against fresh instances and prints a JSON result.
import { runScenario, type Scenario } from "./lib/scenario";
import broadcast from "./scenarios/broadcast";
import channelOutsider from "./scenarios/channel-outsider";
import exchangeRestart from "./scenarios/exchange-restart";
import gatekeeperRestart from "./scenarios/gatekeeper-restart";
import offlineDelivery from "./scenarios/offline-delivery";
import nonMembers from "./scenarios/non-members";
import prQuestion from "./scenarios/pr-question";
import oneReply from "./scenarios/one-reply";
import replyToReply from "./scenarios/reply-to-reply";
import revoke from "./scenarios/revoke";
import revokeQueued from "./scenarios/revoke-queued";
import unknownRecipient from "./scenarios/unknown-recipient";
import { GATE_SCENARIOS } from "./scenarios/gates";
import { INBOX_SCENARIOS } from "./scenarios/inbox";
import { ACTION_SCENARIOS } from "./scenarios/actions";
import { WORKDIR_SCENARIOS } from "./scenarios/workdir";
import { DEVICE_SCENARIOS } from "./scenarios/devices";
import { KEY_SCENARIOS } from "./scenarios/keys";
import { CONFIG_SCENARIOS } from "./scenarios/config";
import { EXPIRY_SCENARIOS } from "./scenarios/expiry";
import { OUTBOX_SCENARIOS } from "./scenarios/outbox";
import { SERVICE_SCENARIOS } from "./scenarios/service";
import { ACTIVITY_SCENARIOS } from "./scenarios/activity";
import { JUDGE_SCENARIOS } from "./scenarios/judge";
import { JOIN_SCENARIOS } from "./scenarios/join";
import { NEEDS_YOU_SCENARIOS } from "./scenarios/needs-you";
import { MOVE_SCENARIOS } from "./scenarios/move";
import { dogfoodFake } from "./dogfood";

export const SCENARIOS: Scenario[] = [
  prQuestion,
  unknownRecipient,
  offlineDelivery,
  exchangeRestart,
  gatekeeperRestart,
  nonMembers,
  revoke,
  broadcast,
  oneReply,
  replyToReply,
  channelOutsider,
  revokeQueued,
  ...GATE_SCENARIOS,
  ...INBOX_SCENARIOS,
  ...ACTION_SCENARIOS,
  ...WORKDIR_SCENARIOS,
  ...DEVICE_SCENARIOS,
  ...KEY_SCENARIOS,
  ...CONFIG_SCENARIOS,
  ...EXPIRY_SCENARIOS,
  ...OUTBOX_SCENARIOS,
  ...SERVICE_SCENARIOS,
  ...ACTIVITY_SCENARIOS,
  ...JUDGE_SCENARIOS,
  ...JOIN_SCENARIOS,
  ...NEEDS_YOU_SCENARIOS,
  ...MOVE_SCENARIOS,
  dogfoodFake,
];

if (import.meta.main) {
  const name = process.argv[2];
  const chosen = name === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.name === name);
  if (!chosen.length) {
    console.error(`usage: just scenario <${["all", ...SCENARIOS.map((s) => s.name)].join("|")}>`);
    process.exit(1);
  }
  const results = [];
  for (const s of chosen) {
    const r = await runScenario(s);
    console.error(`${r.ok ? "PASS" : "FAIL"} ${s.name} (${r.ms} ms) transcript ${r.transcript}${r.error ? ` error: ${r.error}` : ""}`);
    results.push(r);
  }
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
