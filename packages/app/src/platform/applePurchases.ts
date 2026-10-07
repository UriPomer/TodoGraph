import { Capacitor, registerPlugin } from '@capacitor/core';
import { EntitlementsSchema, FREE_ENTITLEMENTS, type Entitlements } from '@todograph/shared';
import { setVerifiedNativeEntitlements } from './workspaceRuntime';

interface ApplePurchasesBridge {
  entitlements(): Promise<Entitlements>;
  products(): Promise<{ products: Array<{ id: string; displayName: string; displayPrice: string }> }>;
  purchase(options: { productId: string }): Promise<{ status: 'purchased' | 'cancelled' | 'pending' }>;
  restore(): Promise<void>;
}
export const ApplePurchases = registerPlugin<ApplePurchasesBridge>('ApplePurchases');
export const applePurchasesAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ApplePurchases');
export async function refreshAppleEntitlements() {
  const entitlements = applePurchasesAvailable()
    ? EntitlementsSchema.parse(await ApplePurchases.entitlements()) : FREE_ENTITLEMENTS;
  setVerifiedNativeEntitlements(entitlements);
  return entitlements;
}
