import { z } from 'zod';
import { SYSTEM_HIERARCHY_PAGE_ID, type Meta } from './schema.js';

export const EntitlementsSchema = z.object({
  plan: z.enum(['free', 'pro']),
  source: z.enum(['none', 'server', 'storekit']),
  expiresAt: z.string().datetime().optional(),
  purchaseAvailable: z.boolean().default(false),
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;
export type ProductPlan = Entitlements['plan'];
export const FREE_ENTITLEMENTS: Entitlements = { plan: 'free', source: 'none', purchaseAvailable: false };
export const PRO_PAGE_LIMIT = 499;

export class ProductAccessError extends Error {
  readonly code = 'PRO_REQUIRED';
  constructor(message = '免费版支持一个清单和一个页面；多页面需要 TodoGraph Pro') {
    super(message);
    this.name = 'ProductAccessError';
  }
}

export function ordinaryPages(meta: Meta) {
  return meta.pages.filter(page => page.id !== SYSTEM_HIERARCHY_PAGE_ID)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function canEditProductPage(meta: Meta, pageId: string, plan: ProductPlan): boolean {
  return plan === 'pro' || pageId === SYSTEM_HIERARCHY_PAGE_ID || ordinaryPages(meta)[0]?.id === pageId;
}

export function assertProductPageEditable(meta: Meta, pageId: string, plan: ProductPlan): void {
  if (!canEditProductPage(meta, pageId, plan)) throw new ProductAccessError('此页面只读；可设为免费可编辑页面，或使用 Pro 编辑多个页面');
}

export function assertProductPageCapacity(meta: Meta, plan: ProductPlan, extra = 1): void {
  const limit = plan === 'pro' ? PRO_PAGE_LIMIT : 1;
  if (ordinaryPages(meta).length + extra > limit) {
    throw new ProductAccessError(plan === 'pro' ? `最多支持 ${limit} 个页面` : undefined);
  }
}
