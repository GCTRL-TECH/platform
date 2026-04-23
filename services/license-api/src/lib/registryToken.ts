export async function generateRegistryToken(_userId: string): Promise<string> {
  return process.env.GHCR_READ_TOKEN ?? process.env.GHCR_TOKEN ?? '';
}
