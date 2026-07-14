// Thin wrapper over the Vibration API. No-ops gracefully where unsupported
// (e.g. iOS Safari), and respects a global enable flag.

export const Haptics = {
  enabled: true,
  supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  buzz(pattern){
    if (this.enabled && this.supported){
      try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
  },
};
