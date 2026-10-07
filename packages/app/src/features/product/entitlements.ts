import { create } from 'zustand';
import { EntitlementsSchema, FREE_ENTITLEMENTS, type Entitlements } from '@todograph/shared';
import { apiFetch, getApiBase, getApiSessionGeneration } from '@/api/client';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { refreshAppleEntitlements } from '@/platform/applePurchases';

interface ProductState {
  entitlements: Entitlements;
  loading: boolean;
  error: string | null;
  proDialogOpen: boolean;
  refresh: () => Promise<void>;
  openPro: () => void;
  closePro: () => void;
}
export const useProductStore = create<ProductState>((set) => ({
  entitlements: FREE_ENTITLEMENTS, loading: false, error: null, proDialogOpen: false,
  openPro: () => set({ proDialogOpen: true }), closePro: () => set({ proDialogOpen: false }),
  refresh: async () => {
    const generation = getApiSessionGeneration();
    set({ loading: true, error: null });
    try {
      if (isLocalWorkspace()) await refreshAppleEntitlements();
      const response = await apiFetch(`${getApiBase()}/api/entitlements`);
      if (!response.ok) throw new Error('无法验证会员权益，请重试');
      const entitlements = EntitlementsSchema.parse(await response.json());
      if (generation === getApiSessionGeneration()) set({ entitlements, loading: false });
    } catch (error) {
      if (generation === getApiSessionGeneration()) set({ entitlements: FREE_ENTITLEMENTS, loading: false, error: (error as Error).message });
    }
  },
}));
