import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { readFileSync } from 'fs';

let _privateKey: Awaited<ReturnType<typeof importPKCS8>>;
let _publicKey: Awaited<ReturnType<typeof importSPKI>>;

async function getPrivateKey() {
  if (!_privateKey) {
    const pem = readFileSync(process.env.LICENSE_PRIVATE_KEY_PATH!, 'utf8');
    _privateKey = await importPKCS8(pem, 'RS256');
  }
  return _privateKey;
}

async function getPublicKey() {
  if (!_publicKey) {
    const pem = readFileSync(process.env.LICENSE_PUBLIC_KEY_PATH!, 'utf8');
    _publicKey = await importSPKI(pem, 'RS256');
  }
  return _publicKey;
}

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

export async function signLicenseJWT(claims: LicenseJWTClaims): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('api.gctrl.tech')
    .setExpirationTime('7d')
    .sign(key);
}

export async function verifyLicenseJWT(token: string): Promise<LicenseJWTClaims> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { issuer: 'api.gctrl.tech' });
  return payload as unknown as LicenseJWTClaims;
}

/**
 * Sign the FUSE entity-resolution tuning profile with the SAME license RS256 key.
 * The agent verifies it with the public key it already embeds — a repo-dropper
 * can't read it (it's not in the public repo) or forge it (no private key).
 */
export async function signTuningJWT(profile: unknown, version: number): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ tuningVersion: version, profile })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('api.gctrl.tech')
    .setSubject('tuning')
    .setExpirationTime('30d')
    .sign(key);
}

export async function signAdminJWT(userId: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ sub: userId, role: 'admin' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('api.gctrl.tech')
    .setExpirationTime('1h')
    .sign(key);
}
