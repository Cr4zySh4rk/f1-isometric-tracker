import { describe, it, expect, vi } from 'vitest';
import { ProviderManager, isFailoverError, MODE_LIVE, MODE_APPROX } from '../src/data/providers/manager.js';

function makePrimary(opts = {}) {
  return {
    id: 'openf1', capabilities: { telemetry: true },
    _probe: opts.probe ?? true,
    getDrivers: opts.getDrivers || (async () => [{ driver_number: 1, src: 'openf1' }]),
    getLocationWindow: opts.getLocationWindow || (async () => [{ x: 1, y: 2 }]),
    probe: async () => (typeof opts.probe === 'function' ? opts.probe() : (opts.probe ?? true)),
  };
}
function makeFallback() {
  return {
    id: 'jolpica', capabilities: { telemetry: false },
    getDrivers: async () => [{ driver_number: 1, src: 'jolpica' }],
    getLocationWindow: async () => null,
    probe: async () => true,
  };
}
const liveBlock = () => Object.assign(new Error('live'), { isLiveBlock: true });
const network = () => Object.assign(new Error('net'), { isNetwork: true });
const apiErr = () => Object.assign(new Error('bad request'), { status: 400 });

describe('isFailoverError', () => {
  it('treats live-block and network errors as failover-worthy; API errors are not', () => {
    expect(isFailoverError(liveBlock())).toBe(true);
    expect(isFailoverError(network())).toBe(true);
    expect(isFailoverError(apiErr())).toBe(false);
    expect(isFailoverError(null)).toBe(false);
  });
});

describe('ProviderManager failover', () => {
  it('serves from primary in live mode', async () => {
    const m = new ProviderManager({ primary: makePrimary(), fallback: makeFallback() });
    expect(m.mode).toBe(MODE_LIVE);
    expect(m.telemetry).toBe(true);
    const d = await m.getDrivers({});
    expect(d[0].src).toBe('openf1');
  });

  it('fails over to Jolpica (approx) on a live-block and retries the call', async () => {
    const primary = makePrimary({ getDrivers: async () => { throw liveBlock(); } });
    const m = new ProviderManager({ primary, fallback: makeFallback() });
    const modes = [];
    m.onModeChange((i) => modes.push(i.reason));
    const d = await m.getDrivers({});
    expect(m.mode).toBe(MODE_APPROX);
    expect(m.telemetry).toBe(false);
    expect(d[0].src).toBe('jolpica'); // the retried call landed on the fallback
    expect(modes).toContain('live-block');
    m.stopRecoveryPoll();
  });

  it('fails over on a genuine network error', async () => {
    const primary = makePrimary({ getDrivers: async () => { throw network(); } });
    const m = new ProviderManager({ primary, fallback: makeFallback() });
    const d = await m.getDrivers({});
    expect(m.mode).toBe(MODE_APPROX);
    expect(d[0].src).toBe('jolpica');
    m.stopRecoveryPoll();
  });

  it('does NOT fail over on a non-network API error — it surfaces to the caller', async () => {
    const primary = makePrimary({ getDrivers: async () => { throw apiErr(); } });
    const m = new ProviderManager({ primary, fallback: makeFallback() });
    await expect(m.getDrivers({})).rejects.toThrow(/bad request/);
    expect(m.mode).toBe(MODE_LIVE);
  });

  it('getLocationWindow returns null through the fallback (drives Approximate mode)', async () => {
    const primary = makePrimary({ getLocationWindow: async () => { throw liveBlock(); } });
    const m = new ProviderManager({ primary, fallback: makeFallback() });
    expect(await m.getLocationWindow({}, 'a', 'b')).toBe(null);
    expect(m.mode).toBe(MODE_APPROX);
    m.stopRecoveryPoll();
  });
});

describe('ProviderManager recovery', () => {
  it('promotes back to live when OpenF1 probe succeeds', async () => {
    const m = new ProviderManager({ primary: makePrimary({ probe: true }), fallback: makeFallback() });
    m.forceApprox('test');
    expect(m.mode).toBe(MODE_APPROX);
    const modes = [];
    m.onModeChange((i) => modes.push(i.mode));
    const mode = await m.checkRecovery();
    expect(mode).toBe(MODE_LIVE);
    expect(m.mode).toBe(MODE_LIVE);
    expect(modes).toContain(MODE_LIVE);
    m.stopRecoveryPoll();
  });

  it('stays degraded while OpenF1 is still down', async () => {
    const m = new ProviderManager({ primary: makePrimary({ probe: false }), fallback: makeFallback() });
    m.forceApprox('test');
    expect(await m.checkRecovery()).toBe(MODE_APPROX);
    expect(m.mode).toBe(MODE_APPROX);
    m.stopRecoveryPoll();
  });

  it('drives recovery via an injectable scheduler (60 s poll)', async () => {
    let probeCalls = 0;
    const primary = makePrimary({ probe: () => { probeCalls++; return true; } });
    let tickFn = null;
    const scheduler = {
      setInterval: (fn) => { tickFn = fn; return 1; },
      clearInterval: () => { tickFn = null; },
    };
    const m = new ProviderManager({ primary, fallback: makeFallback(), scheduler });
    m.forceApprox('test'); // starts the poll via scheduler
    expect(typeof tickFn).toBe('function');
    await tickFn(); // simulate one 60 s tick
    // give the async checkRecovery microtask a chance
    await Promise.resolve();
    expect(probeCalls).toBeGreaterThan(0);
  });
});
