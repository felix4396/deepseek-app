import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.deepseekchat',
  appName: 'DeepSeek Chat',
  webDir: 'dist',
  android: {
    allowMixedContent: true
  }
};

export default config;
