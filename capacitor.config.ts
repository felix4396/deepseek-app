import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.deepseekchat',
  appName: '鲸落',
  webDir: 'dist',
  android: {
    allowMixedContent: true
  }
};

export default config;
