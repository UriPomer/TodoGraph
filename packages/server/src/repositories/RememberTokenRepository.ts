export type ConsumeRememberTokenResult =
  | { status: 'valid'; userId: string; sessionVersion: number; rotatedToken?: string; expiresAt: string }
  | { status: 'invalid' | 'replayed' };

export type RememberTokenPurpose = 'browser' | 'native';
export type VerifyRememberTokenResult =
  | { status: 'valid'; userId: string; sessionVersion: number; expiresAt: string }
  | { status: 'invalid' };

export interface RememberTokenRepository {
  issue(
    userId: string,
    sessionVersion: number,
    options?: { purpose?: RememberTokenPurpose; lifetimeMs?: number },
  ): Promise<string>;
  consume(rawToken: string): Promise<ConsumeRememberTokenResult>;
  verify(rawToken: string, purpose: RememberTokenPurpose): Promise<VerifyRememberTokenResult>;
  revoke(rawToken: string): Promise<void>;
  revokeUser(userId: string): Promise<void>;
}
