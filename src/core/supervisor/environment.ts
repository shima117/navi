/** Local voice/model helpers do not need the cloud credential, even when main has it. */
export function localHelperEnvironment(inherited: Record<string, string | undefined>, configured?: Record<string, string>): Record<string, string | undefined> {
  const environment = { ...inherited, ...configured };
  for (const key of Object.keys(environment)) if (key.toUpperCase() === 'OPENAI_API_KEY') delete environment[key];
  return environment;
}
