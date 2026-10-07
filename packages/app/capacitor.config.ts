import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.todograph.app',
  appName: 'TodoGraph',
  webDir: 'dist',
  backgroundColor: '#151317',
  loggingBehavior: 'debug',
  plugins: {
    AppleCloud: { containerId: process.env.TODOGRAPH_CLOUDKIT_CONTAINER ?? '' },
    ApplePurchases: {
      productIds: (process.env.TODOGRAPH_APPLE_PRO_PRODUCT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    },
    CapacitorHttp: { enabled: true },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
      autoBackdropColor: 'auto',
    },
    SystemBars: {
      insetsHandling: 'css',
      style: 'DARK',
      hidden: false,
      animation: 'NONE',
    },
  },
};

export default config;
