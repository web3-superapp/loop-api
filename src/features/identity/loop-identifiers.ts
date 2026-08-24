const internalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deriveStreamUserId(internalUserId: string): string {
  if (!internalUuidPattern.test(internalUserId)) {
    throw new Error("Internal user ID is not a UUID");
  }

  return `loop_${internalUserId.replaceAll("-", "").toLowerCase()}`;
}
