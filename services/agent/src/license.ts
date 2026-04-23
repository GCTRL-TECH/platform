import { readFileSync, writeFileSync, existsSync } from 'fs';
import { importSPKI, jwtVerify } from 'jose';

export interface LicenseJWTClaims {
  sub: string;
  licenseId: string;
  tier: string;
  creditsBalance: number;
  overdraftLimit: number;
  hardwareFingerprint: string;
  latestVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
}

const JWT_PATH = process.env.GCTRL_LICENSE_JWT_PATH ?? '/app/config/license.jwt';

export class LicenseCache {
  private claims: LicenseJWTClaims | null = null;

  setFromClaims(claims: LicenseJWTClaims) {
    this.claims = claims;
  }

  async loadFromDisk(): Promise<boolean> {
    if (!existsSync(JWT_PATH)) return false;
    const token = readFileSync(JWT_PATH, 'utf8').trim();
    return this.loadFromToken(token);
  }

  async loadFromToken(token: string): Promise<boolean> {
    try {
      const publicKeyPem = process.env.GCTRL_LICENSE_PUBLIC_KEY!;
      const key = await importSPKI(publicKeyPem, 'RS256');
      const { payload } = await jwtVerify(token, key, { issuer: 'api.gctrl.tech' });
      this.claims = payload as unknown as LicenseJWTClaims;
      writeFileSync(JWT_PATH, token, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  isValid(): boolean { return this.claims !== null; }
  getTier(): string { return this.claims?.tier ?? 'free'; }
  getBalance(): number { return this.claims?.creditsBalance ?? 0; }
  getOverdraftLimit(): number { return this.claims?.overdraftLimit ?? 0; }
  getFingerprint(): string { return this.claims?.hardwareFingerprint ?? ''; }
  isUpdateRequired(): boolean { return this.claims?.updateRequired ?? false; }
  isUpdateAvailable(): boolean { return this.claims?.updateAvailable ?? false; }
  getLatestVersion(): string { return this.claims?.latestVersion ?? ''; }

  canSpend(credits: number): boolean {
    if (!this.claims) return false;
    return (this.claims.creditsBalance - credits) >= this.claims.overdraftLimit;
  }

  deductLocal(credits: number) {
    if (this.claims) this.claims.creditsBalance -= credits;
  }
}

export const licenseCache = new LicenseCache();
