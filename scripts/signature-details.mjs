export function signatureDetails(result) {
  if (result.error || result.status !== 0) throw new Error('codesign could not inspect the application');
  // codesign -d writes successful descriptive output to stderr, not stdout.
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}
