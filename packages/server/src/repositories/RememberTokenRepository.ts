export type ConsumeRememberTokenResult =
  | { status: 'valid'; userId: string; sessionVersion: number; token: string; expiresAt: string }
  | { status: 'invalid' | 'replayed' };

export interface RememberTokenRepository {
  issue(userId: string, sessionVersion: number): Promise<string>;
  consume(rawToken: string): Promise<ConsumeRememberTokenResult>;
  revoke(rawToken: string): Promise<void>;
  revokeUser(userId: string): Promise<void>;
}
