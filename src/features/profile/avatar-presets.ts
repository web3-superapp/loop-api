/**
 * Preset avatar catalog (Decision 0030). Avatar upload has no selected
 * storage Provider, so V2 profile writes accept only these opaque references
 * or `null`. The people atlas is 4 columns by 3 rows (12 slots); the
 * monogram preset renders the alias initial client-side.
 */

export type AvatarAtlas = "people" | "monogram";

export interface AvatarPreset {
  readonly avatarRef: string;
  readonly atlas: AvatarAtlas;
  readonly slot: number | null;
  readonly label: string;
}

export const avatarPeopleAtlasColumns = 4;
export const avatarPeopleAtlasRows = 3;
export const avatarPeopleSlotCount =
  avatarPeopleAtlasColumns * avatarPeopleAtlasRows;
export const avatarPresetRefPatternSource =
  "^avatar:preset/(people-(0[1-9]|1[0-2])|monogram)$";

function peoplePreset(slot: number): AvatarPreset {
  const padded = String(slot).padStart(2, "0");
  return Object.freeze({
    avatarRef: `avatar:preset/people-${padded}`,
    atlas: "people",
    slot,
    label: `People ${padded}`,
  });
}

export const avatarPresets: readonly AvatarPreset[] = Object.freeze([
  ...Array.from({ length: avatarPeopleSlotCount }, (_, index) =>
    peoplePreset(index + 1),
  ),
  Object.freeze({
    avatarRef: "avatar:preset/monogram",
    atlas: "monogram",
    slot: null,
    label: "Monogram",
  }),
]);

const presetRefs: ReadonlySet<string> = new Set(
  avatarPresets.map((preset) => preset.avatarRef),
);

export function isAvatarPresetRef(value: unknown): value is string {
  return typeof value === "string" && presetRefs.has(value);
}
