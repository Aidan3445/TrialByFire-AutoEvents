import { noul, keyOf, qset, withCanaries } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

function build(c) {
  const q = qset();
  q.add("advantage_handed_off", noul(
    "One castaway gives an idol or advantage to another castaway to keep in this excerpt. Playing an idol on someone's behalf at tribal council does not count. Offering it without handing it over does not count."
  ));
  for (const name of withCanaries(c.cast, c)) {
    const k = keyOf(name);
    q.add(`gave_${k}`, noul(`${name} gave an idol or advantage to another castaway.`), "advantage_handed_off");
    q.add(`received_${k}`, noul(`${name} received an idol or advantage from another castaway.`), "advantage_handed_off");
  }
  return q;
}

export default {
  id: "handoff",
  events: ["otherNotes"],
  start: phrases([
    "give you my idol",
    "give you my advantage",
    "give you my shot in the dark",
    "give you the idol",
    "give him my idol",
    "give her my idol",
    "gave him my idol",
    "gave her my idol",
    "gave them my idol",
    "hand you my idol",
    "handed him my idol",
    "handed her my idol",
    "hand over my idol",
    "give it to you",
    "gave it to him",
    "gave it to her",
    "give this to you",
    "hand it to you",
    "idol is yours",
    "advantage is yours",
    "idol for you",
    "advantage for you",
  ]),
  maxSpan: 120,
  build,
  templates: [
    { "gave_{giver}_to_{receiver}": noul("{giver} gave an idol or advantage to {receiver}.") },
  ],
};
