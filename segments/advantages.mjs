// Choice option key -> [app label (BaseEventLabels), description]
export const ADVANTAGES = {
  idol: ["Idol", "a hidden immunity idol"],
  extra_vote: ["Extra Vote", "an extra vote at tribal council"],
  steal_a_vote: ["Steal a Vote", "the power to take another castaway's vote and cast it yourself"],
  block_a_vote: ["Block a Vote", "the power to take away another castaway's vote"],
  safety_without_power: ["Safety Without Power", "the power to leave tribal council safe, without voting"],
  idol_nullifier: ["Idol Nullifier", "the power to cancel an idol played by another castaway"],
  knowledge_is_power: ["Knowledge is Power", "the power to demand an advantage from another castaway"],
  challenge_advantage: ["Challenge Advantage", "an edge in an upcoming challenge"],
  beware_advantage: [
    "Beware Advantage",
    "an advantage that costs the holder something, such as their vote, until they complete a task",
  ],
  novel: ["Advantage", "an advantage that does not match any of the kinds listed"],
};

export const TRIBAL_ADVANTAGES = [
  "idol", "extra_vote", "steal_a_vote", "block_a_vote", "safety_without_power",
  "idol_nullifier", "knowledge_is_power", "novel",
];

export const advantageCriteria = (keys) =>
  Object.fromEntries(keys.map((k) => [k, ADVANTAGES[k][1]]));

export const ADVANTAGE_LABELS = Object.fromEntries(
  Object.entries(ADVANTAGES).map(([k, [label]]) => [k, label])
);
