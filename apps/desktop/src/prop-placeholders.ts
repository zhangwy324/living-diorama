import type { PropPlaceholder } from "@living-diorama/renderer";

// Stand-in looks for the built-in pack's prop models until real assets exist (roadmap M4).
export const propPlaceholders: Record<string, PropPlaceholder> = {
  "hollow:models/pine.glb": { shape: "conifer", color: "#3f6b3a" },
  "hollow:models/round-tree.glb": { shape: "broadleaf", color: "#5d8f3e" },
  "hollow:models/rock.glb": { shape: "rock", color: "#8d8a84" },
  "hollow:models/bush.glb": { shape: "bush", color: "#4f7d38" },
  "hollow:models/mushroom.glb": { shape: "mushroom", color: "#c8553d" },
};
