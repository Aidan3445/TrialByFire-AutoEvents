/** Name -> question key fragment: "Yam Yam" -> "yam_yam". */
export const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
