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
