import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.todograph.app',
  appName: 'TodoGraph',
  webDir: 'dist',
  backgroundColor: '#151317',
  loggingBehavior: 'debug',
  plugins: {
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
