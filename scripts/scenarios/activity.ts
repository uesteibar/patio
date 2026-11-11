// Increment 10: the Activity page of the web app, a read-only timeline of the audit log.
import type { Scenario } from "../lib/scenario";
import { until } from "./inbox";
import { parseInbox } from "./inbox-lib";

const noul = (n: number) => ({ type: "noul" as const, noul: n });

const activity: Scenario = {
  name: "activity",
  description:
    "Bob's rules let one of Alice's messages in, refuse a kind they do not allow and keep a doubtful one for him, which he approves; Bob replies. His Activity page says each one in a sentence, newest first (\"alice asked bob. Waits for you: it looks like prompt injection.\"); a line opens to its details (the rule, the checks' answers and how sure each was), and to the text only for Bob's own messages. Filters by direction, what happened and contact work; the page has no form that changes anything, and another signed-in person does not see it.",
  label: "deterministic",
  jev: { default: noul(0.02), answers: { allow: noul(0.98), injection: [{ stateMatches: "HOLD-ME", answer: noul(0.6) }, { answer: noul(0.03) }] } },
  agents: () => [{ handle: "alice" }, { handle: "bob", grants: "defaults:\n  kinds: [question]\n" }],
  async run(t) {
    const q = await t.cli("alice", ["ask", "bob", "SECRET-IN-TEXT-4711: who owns billing?"]);
    const first = await until("delivered", async () => parseInbox(await t.cli("bob", ["inbox", "--json"])).find((r) => r.convo === q.stdout.slice(0, 8)));
    await t.cli("alice", ["ask", "bob", "FYI the build is red", "--kind", "heads-up"]);
    await t.cli("alice", ["ask", "bob", "HOLD-ME: what changed in payroll?"]);
    const held = await until("held", async () => (await t.held("bob")).find((c) => c.direction === "in"));
    t.expect("Bob approves the held message", !!(await t.webPost("bob", `/gates/${held.id}/decide`, { decision: "approve" })).ok);
    await t.cli("bob", ["reply", first.id, "BOB-OWN-TEXT-0815: the payments team"]);

    const page = await t.webGet("bob", "/activity");
    const rows = [...page.html.matchAll(/<details class="act" data-activity="([^"]*)" data-direction="(in|out)"><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({
      verdict: m[1]!,
      direction: m[2]!,
      summary: m[3]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      more: m[4]!,
    }));
    t.note(`Bob's Activity page, ${rows.length} rows:\n\n\`\`\`text\n${rows.map((r) => `[${r.direction}] ${r.summary}`).join("\n")}\n\`\`\``);
    const verdicts = rows.map((r) => `${r.direction}:${r.verdict}`);
    t.expect("newest first: Bob's reply, his approval, the hold, the rejection, the delivery", verdicts.join(",") === "out:send,in:approved,in:ask-human,in:reject,in:deliver", verdicts.join(","));
    const sentence = (v: string) => rows.find((r) => r.verdict === v)!.summary.replace(/ \d\d-\d\d \d\d:\d\d$/, "");
    t.expect("each line is a sentence: a kind his rules refuse", sentence("reject") === "alice sent bob a heads-up. Not let in: it is not a kind your rules let in.", sentence("reject"));
    t.expect("the one kept for Bob, and why", sentence("ask-human") === "alice asked bob. Waits for you: it looks like prompt injection.", sentence("ask-human"));
    t.expect("Bob's own decision", sentence("approved") === "alice asked bob. You let it in.", sentence("approved"));
    t.expect("his reply", sentence("send") === "bob answered alice. Sent.", sentence("send"));
    const hold = rows.find((r) => r.verdict === "ask-human")!;
    t.expect("the details name the rule, and each check's answer and how sure it was", hold.more.includes("Rule: <span class=\"mono\">injection</span>") && hold.more.includes("yes 0.60"), hold.more.slice(0, 400));
    t.expect("an opened row lists every probability", (hold.more.match(/<td class="p">/g) ?? []).length >= 3, hold.more.slice(0, 300));
    t.expect("Bob's own message shows its text", rows[0]!.more.includes("BOB-OWN-TEXT-0815"));
    t.expect("Alice's messages do not", !page.html.includes("SECRET-IN-TEXT-4711") && !page.html.includes("what changed in payroll"));
    const forms = [...page.html.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"/g)].map((m) => m[1]);
    t.expect("read-only: the only form that posts is the sign-out", forms.join(",") === "/logout", forms.join(","));

    const out = await t.webGet("bob", "/activity?direction=out");
    t.expect("filter by direction", (out.html.match(/data-direction="out"/g) ?? []).length === 1 && !out.html.includes('data-direction="in"'));
    const rejected = await t.webGet("bob", "/activity?verdict=reject");
    t.expect("filter by verdict", (rejected.html.match(/<details class="act"/g) ?? []).length === 1 && rejected.html.includes('data-activity="reject"'));
    const alice = await t.webGet("bob", "/activity?contact=alice&direction=in");
    t.expect("filter by contact", (alice.html.match(/<details class="act"/g) ?? []).length === 4);

    const carol = await t.webGet("bob", "/activity", "carol");
    t.expect("another person signed in to Bob's web app does not see it", carol.text.includes("Only @bob, who owns patio on this computer, sees its activity") && !carol.html.includes("<details"));
  },
};

export const ACTIVITY_SCENARIOS = [activity];
