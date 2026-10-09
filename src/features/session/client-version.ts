export const clientVersionMinimumLength = 5;
export const clientVersionMaximumLength = 64;

const prereleaseIdentifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";

export const clientVersionSemver2PatternSource =
  `^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)` +
  `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?![\\s\\S])";

const clientVersionSemver2Pattern = new RegExp(
  clientVersionSemver2PatternSource,
);

export function isValidClientVersion(value: string): boolean {
  return (
    value.length >= clientVersionMinimumLength &&
    value.length <= clientVersionMaximumLength &&
    clientVersionSemver2Pattern.test(value)
  );
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * SemVer 2.0 precedence for two already validated client versions. Build
 * metadata is ignored; a prerelease sorts below its release. Returns -1, 0, or 1.
 */
export function compareClientVersions(left: string, right: string): number {
  if (!isValidClientVersion(left) || !isValidClientVersion(right)) {
    throw new TypeError("Client versions must be valid SemVer 2.0 strings");
  }
  const strip = (
    value: string,
  ): { core: string; prerelease: string | null } => {
    const withoutBuild = value.split("+", 1)[0] ?? value;
    const hyphenIndex = withoutBuild.indexOf("-");
    return hyphenIndex === -1
      ? { core: withoutBuild, prerelease: null }
      : {
          core: withoutBuild.slice(0, hyphenIndex),
          prerelease: withoutBuild.slice(hyphenIndex + 1),
        };
  };
  const leftParts = strip(left);
  const rightParts = strip(right);
  const leftCore = leftParts.core.split(".");
  const rightCore = rightParts.core.split(".");
  for (let index = 0; index < 3; index += 1) {
    const result = compareIdentifiers(
      leftCore[index] ?? "0",
      rightCore[index] ?? "0",
    );
    if (result !== 0) {
      return result;
    }
  }
  if (leftParts.prerelease === null || rightParts.prerelease === null) {
    if (leftParts.prerelease === rightParts.prerelease) {
      return 0;
    }
    return leftParts.prerelease === null ? 1 : -1;
  }
  const leftIdentifiers = leftParts.prerelease.split(".");
  const rightIdentifiers = rightParts.prerelease.split(".");
  const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const result = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}
